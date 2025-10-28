// --- 1. IMPORTS AND SETUP ----------------------------------------------------------------------------------------------------------------------------
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const csv = require('csv-parser');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const app = express();
app.use(cors());
app.use(express.json());
const port = 3000;

// --- DATABASE CONNECTION ------------------------------------------------------------------------------------------------------------------------------
const pool = new Pool({
    host: process.env.DB_HOST || 'postgres', // Default to service name if env var missing
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER || 'ayush',
    password: process.env.DB_PASSWORD || 'ayushpassword',
    database: process.env.DB_NAME || 'ayushdb',
});
console.log('Attempting to connect to PostgreSQL database...');
pool.connect()
    .then(client => {
        console.log('✅ Successfully connected to PostgreSQL database.');
        client.release();
    })
    .catch(err => {
        console.error('❌ Error connecting to PostgreSQL database:', err.stack);
        // Consider exiting if DB connection fails on startup
        // process.exit(1);
    });


// --- HELPER FUNCTIONS ---------------------------------------------------------------------------------------------------------------------------------

// (extractNamasteCode and extractMappingCodes remain unchanged)
function extractNamasteCode(inputString) {
    if (!inputString || typeof inputString !== 'string') { return null; }
    const namastePattern = /(^[A-Z]{3}-\d+$)|(^[A-Z]{1,3}$)/;
    const potentialCodes = inputString.replace(/[()]/g, ' ').trim().split(/\s+/);
    for (const code of potentialCodes) { if (namastePattern.test(code)) { return code; } }
    return potentialCodes[0] || null;
}
function extractMappingCodes(inputString) {
    if (!inputString || typeof inputString !== 'string') return { namasteCode: null, icdCode: null };
    const parts = inputString.replace(/[()]/g, ' ').trim().split(/\s+/).filter(p => p);
    if (parts.length < 2) { const namastePattern = /(^[A-Z]{3}-\d+$)|(^[A-Z]{1,3}$)/; if(namastePattern.test(parts[0])) return { namasteCode: parts[0], icdCode: null }; return { namasteCode: parts[0] || null, icdCode: null }; }
    const icdPattern = /^[A-Z]{1,3}\d+(\.\d+)?([A-Z])?$/; // More robust ICD code pattern
    let icdCode = null; let namasteCode = null;
    for (const part of parts) { if (icdPattern.test(part)) icdCode = part; else namasteCode = part; }
    return { namasteCode, icdCode };
}

// (generateCodeSystem remains unchanged - used by /codesystem endpoints)
async function generateCodeSystem(config) {
    const { tableName, csvFilePath, codeSystemId, codeSystemName, csvCodeColumn, csvDisplayColumn } = config;
    await pool.query(`CREATE TABLE IF NOT EXISTS ${tableName} (id SERIAL PRIMARY KEY, code VARCHAR(50) UNIQUE NOT NULL, display TEXT, definition TEXT, broader_term TEXT);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS namaste_icd_mappings (id SERIAL PRIMARY KEY, source_system TEXT, source_code TEXT, target_system TEXT, target_code TEXT, UNIQUE(source_code, target_code));`);
    const csvRows = [];
    await new Promise((resolve, reject) => { fs.createReadStream(csvFilePath).pipe(csv()).on('data', (data) => csvRows.push(data)).on('end', resolve).on('error', reject); });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const row of csvRows) {
            const rawCode = row[csvCodeColumn]; const display = row[csvDisplayColumn]; const definition = row['Long_definition'] || row['Short_definition']; const { namasteCode, icdCode } = extractMappingCodes(rawCode);
            if (namasteCode && display) { const broaderTerm = row['Ontology_branches']; await client.query(`INSERT INTO ${tableName} (code, display, definition, broader_term) VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO UPDATE SET display = EXCLUDED.display, definition = EXCLUDED.definition, broader_term = EXCLUDED.broader_term;`, [namasteCode, display, definition, broaderTerm]); }
            if (namasteCode && icdCode) { await client.query(`INSERT INTO namaste_icd_mappings (source_system, source_code, target_system, target_code) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING;`, [`https://www.ayush-bridge.org/fhir/CodeSystem/${codeSystemId}`, namasteCode, 'http://id.who.int/icd/release/11/mms', icdCode]); }
        } await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    const { rows } = await pool.query(`SELECT t1.code, t1.display, t1.definition, t2.target_code AS icd_code, t3.foundation_uri, t3.linearization_url FROM ${tableName} AS t1 LEFT JOIN namaste_icd_mappings AS t2 ON t1.code = t2.source_code LEFT JOIN icd11_codes_master AS t3 ON t2.target_code = t3.code ORDER BY t1.code;`);
    const codeSystem = {
        resourceType: "CodeSystem", id: codeSystemId, name: codeSystemName, title: `NAMASTE ${codeSystemName} Terminology`, status: "active",
        url: `https://www.ayush-bridge.org/fhir/CodeSystem/${codeSystemId}`, date: new Date().toISOString(), publisher: "Ministry of Ayush, Government of India", content: "complete",
        property: [
            { code: "foundationUri", uri: "https://www.ayush-bridge.org/fhir/property/foundationUri", description: "The WHO ICD-11 Foundation URI", type: "uri" },
            { code: "linearizationUrl", uri: "https://www.ayush-bridge.org/fhir/property/linearizationUrl", description: "The WHO ICD-11 Browser/Linearization URL", type: "uri" }
        ],
        concept: rows.map(row => {
            const properties = [];
            if (row.foundation_uri) properties.push({ code: "foundationUri", valueUri: row.foundation_uri });
            if (row.linearization_url) properties.push({ code: "linearizationUrl", valueUri: row.linearization_url });
            return {
                code: row.code,
                display: row.display,
                definition: row.definition || undefined,
                property: properties.length > 0 ? properties : undefined,
            };
        })
    };
    return codeSystem;
}


function createTranslationResponse(result, matches = []) {
    return {
        resourceType: "Parameters",
        parameter: [
            { name: "result", valueBoolean: result },
            ...matches.map(m => ({
                name: "match",
                part: [
                    { name: "equivalence", valueCode: "equivalent" },
                    { 
                        name: "concept", 
                        valueCoding: { 
                            system: m.system, 
                            code: m.code,
                            display: m.display
                        } 
                    },
                    // Add the new details to the response if they exist
                    m.browserUrl ? { name: "url", valueUrl: m.browserUrl } : null,
                    m.foundationUri ? { name: "source", valueUri: m.foundationUri } : null
                ].filter(p => p) // This removes any null parts
            }))
        ]
    };
}


/**
 * [AUTHENTICATION MIDDLEWARE]
 * Verifies the JWT from the Authorization header.
 */
function authenticateToken(req, res, next) {
    // Get the token from the header, which is in the format "Bearer TOKEN"
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    // If no token is provided, send an "Unauthorized" error
    if (token == null) {
        return res.sendStatus(401); // Unauthorized
    }

    // Verify the token
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.sendStatus(403); // Forbidden (token is no longer valid)
        }
        // If the token is valid, save the user info to the request and continue
        req.user = user;
        next();
    });
}



// --- 4. API ENDPOINTS -----------------------------------------------

/**
 * @openapi
 * /:
 * get:
 * summary: Health check endpoint
 * description: Returns a simple message indicating the service is running.
 * tags: [General]
 * responses:
 * 200:
 * description: Service is running.
 * content:
 * text/plain:
 * schema:
 * type: string
 * example: AYUSH-BRIDGE Terminology Service is running...
 */
app.get('/', (_req, res) => {
    res.send('AYUSH-BRIDGE Terminology Service is running.');
});


// Endpoint to generate and return the Ayurveda CodeSystem

app.get('/codesystem/ayurveda', async (_req, res) => {
    try {
        const ayurvedaConfig = {
            tableName: 'namaste_ayurveda_codes',
            csvFilePath: './NATIONAL_AYURVEDA_MORBIDITY_CODES.csv',
            codeSystemId: 'namaste-ayurveda',
            codeSystemName: 'Ayurveda',
            csvCodeColumn: 'NAMC_CODE',
            csvDisplayColumn: 'NAMC_term',
            csvSynonymColumn: 'SYNONYMS', 
            csvBroaderTermColumn: 'BROADER TERM' 
        };
        const codeSystem = await generateCodeSystem(ayurvedaConfig);
        res.status(200).json(codeSystem);
    } catch (error) {
        console.error("Error generating Ayurveda CodeSystem:", error);
        res.status(500).json({ error: "Failed to generate Ayurveda CodeSystem.", details: error.message });
    }
});

// Endpoint to generate and return the Siddha CodeSystem
app.get('/codesystem/siddha', async (_req, res) => {
    try {
        const siddhaConfig = {
            tableName: 'namaste_siddha_codes',
            csvFilePath: './NATIONAL SIDDHA MORBIDITY CODES.xls - NATIONAL-SIDDHA-MORBIDITY-CODES.csv',
            codeSystemId: 'namaste-siddha',
            codeSystemName: 'Siddha',
            csvCodeColumn: 'NAMC_CODE',
            csvDisplayColumn: 'NAMC_TERM',
            csvSynonymColumn: 'SYNONYMS', 
            csvBroaderTermColumn: 'BROADER TERM' 
        };
        const codeSystem = await generateCodeSystem(siddhaConfig);
        res.status(200).json(codeSystem);
    } catch (error) {
        console.error("Error generating Siddha CodeSystem:", error);
        res.status(500).json({ error: "Failed to generate Siddha CodeSystem.", details: error.message });
    }
});

// Endpoint to generate and return the Unani CodeSystem
app.get('/codesystem/unani', async (_req, res) => {
    try {
        const unaniConfig = {
            tableName: 'namaste_unani_codes',
            csvFilePath: './NATIONAL UNANI MORBIDITY CODES.xls - NATIONAL-UNANI-MORBIDITY-CODES.csv',
            codeSystemId: 'namaste-unani',
            codeSystemName: 'Unani',
            csvCodeColumn: 'NUMC_CODE',
            csvDisplayColumn: 'NUMC_TERM',
            csvSynonymColumn: 'SYNONYMS', 
            csvBroaderTermColumn: 'BROADER TERM'
        };
        const codeSystem = await generateCodeSystem(unaniConfig);
        res.status(200).json(codeSystem);
    } catch (error) {
        console.error("Error generating Unani CodeSystem:", error);
        res.status(500).json({ error: "Failed to generate Unani CodeSystem.", details: error.message });
    }
});

// (ingestSatTable helper used by /ingest/all-knowledge)
async function ingestSatTable(client, csvPath, tableName) {
    console.log(`Ingesting ${csvPath} into ${tableName}...`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${tableName} (id SERIAL PRIMARY KEY, code TEXT UNIQUE, parent_id TEXT, word TEXT, short_defination TEXT, long_defination TEXT, reference TEXT);`);
    const rows = [];
    await new Promise((resolve, reject) => {
        fs.createReadStream(csvPath).pipe(csv()).on('data', (data) => rows.push(data)).on('end', resolve).on('error', reject);
    });
    for (const row of rows) {
        await client.query(`INSERT INTO ${tableName} (code, parent_id, word, short_defination, long_defination, reference) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (code) DO NOTHING;`, [row.Code, row.parent_id, row.Word, row.Short_Defination, row.Long_Defination, row.reference]);
    }
    console.log(`✅ Finished ingesting ${tableName}.`);
    return rows.length;
}

// (getIcdDetails helper remains unchanged - used by /lookup and potentially internally)
async function getIcdDetails(icdCode) {
    const whoApiUrl = `http://icd11-service:80/icd/release/11/mms/lookup?code=${icdCode}`; // Use service name
    try {
        const response = await axios.get(whoApiUrl, { headers: { 'Accept': 'application/json', 'API-Version': 'v2', 'Accept-Language': 'en' } });
        const data = response.data;
        return { display: data.title['@value'], browserUrl: data.browserUrl, foundationUri: data.source };
    } catch (error) { console.error(`Failed to fetch details for ICD code ${icdCode}:`, error.message); return { display: "Official description not found.", browserUrl: null, foundationUri: null }; }
}

/**
 * [NEW] Master Ingestion Endpoint
 * Run this ONCE to populate your database with all the Ayurvedic knowledge.
 * This also ingests your main ICD-11 file into BOTH PostgreSQL AND the AI service.
 */
app.post('/ingest/all-knowledge', async (req, res) => {
    const client = await pool.connect();
    let aiEmbeddingsAdded = 0;

    try {
        await client.query('BEGIN');

        // --- (This SAT table ingestion is unchanged) ---
        const satTables = [
            { path: './ayu-sat-table-a.csv', table: 'sat_a_fundamental' },
            { path: './ayu-sat-table-b.csv', table: 'sat_b_anatomy' },
            { path: './ayu-sat-table-c.csv', table: 'sat_c_diagnosis' },
            { path: './ayu-sat-table-d.csv', table: 'sat_d_diagnosis_alt' },
            { path: './ayu-sat-table-f.csv', table: 'sat_f_pharma' },
            { path: './ayu-sat-table-g.csv', table: 'sat_g_pharma_prep' },
            { path: './ayu-sat-table-h.csv', table: 'sat_h_food_prep' },
            { path: './ayu-sat-table-i.csv', table: 'sat_i_treatment' },
            { path: './ayu-sat-table-j.csv', table: 'sat_j_preventive' },
        ];
        
        for (const sat of satTables) {
            // Assuming ingestSatTable function exists from previous step
            await ingestSatTable(client, sat.path, sat.table);
        }

        // --- [THIS PART IS UPDATED] ---
        // Now, ingest the FULL ICD-11 CSV
        console.log('Ingesting full ICD-11 CSV into Postgres and AI Service...');
        await client.query(`CREATE TABLE IF NOT EXISTS icd11_codes_master (id SERIAL PRIMARY KEY, code TEXT UNIQUE, title TEXT, foundation_uri TEXT, linearization_url TEXT);`);
        const icdRows = [];
        
        // --- Make sure to update this path to your FULL ICD-11 file ---
        const icdCsvPath = './icd-11.csv';
        if (!fs.existsSync(icdCsvPath)) {
            throw new Error(`ICD-11 file not found at ${icdCsvPath}`);
        }

        await new Promise((resolve, reject) => {
            fs.createReadStream(icdCsvPath).pipe(csv()).on('data', (data) => icdRows.push(data)).on('end', resolve).on('error', reject);
        });
        
        const keyMap = { code: 'Code', title: 'Title', foundationUri: 'Foundation URI', linearizationUrl: 'Linearization URI' };

        for (const row of icdRows) {
            const code = row[keyMap.code];
            let title = row[keyMap.title];
            const foundationUri = row[keyMap.foundationUri];
            const linearizationUrl = row[keyMap.linearizationUrl];
            
            if (code && title) {
                // 1. Clean title
                title = title.replace(/^-+\s*/, '').trim();

                // 2. Add to PostgreSQL (unchanged)
                await client.query(`INSERT INTO icd11_codes_master (code, title, foundation_uri, linearization_url) VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO UPDATE SET title=EXCLUDED.title, foundation_uri=EXCLUDED.foundation_uri, linearization_url=EXCLUDED.linearization_url;`, [code, title, foundationUri, linearizationUrl]);

                // 3. --- [NEW] --- Add to AI Vector Database
                try {
                    await axios.post('http://ai-service:5000/add-embedding', {
                        id: code,
                        text: title
                    });
                    aiEmbeddingsAdded++;
                } catch (aiError) {
                    console.warn(`Warning: Failed to add embedding for ${code}. AI service might be down or file exists.`, aiError.message);
                }
            }
        }
        
        await client.query('COMMIT');
        console.log(`✅ Finished ingesting ICD-11. ${aiEmbeddingsAdded} embeddings added to AI service.`);
        res.status(200).send(`Successfully ingested all knowledge sources. ${aiEmbeddingsAdded} AI embeddings created.`);

    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Master ingestion failed:', e);
        res.status(500).json({ error: "Master ingestion failed.", details: e.message });
    } finally {
        client.release();
    }
});

app.get('/conceptmap/ayurveda-to-icd11', async (_req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM namaste_icd_mappings');
        
        const conceptMap = {
            resourceType: "ConceptMap",
            id: "namaste-ayurveda-to-icd11-tm2",
            url: "https://www.ayush-bridge.org/fhir/ConceptMap/namaste-ayurveda-to-icd11-tm2",
            version: "1.0.0",
            name: "NAMASTEAyurvedaToICD11TM2",
            title: "NAMASTE Ayurveda to ICD-11 TM2 Mapping",
            status: "active",
            date: new Date().toISOString(),
            publisher: "AYUSH-BRIDGE Project",
            sourceUri: "https://www.ayush-bridge.org/fhir/CodeSystem/namaste-ayurveda",
            targetUri: "http://id.who.int/icd/release/11/mms",
            group: [{
                source: "https://www.ayush-bridge.org/fhir/CodeSystem/namaste-ayurveda",
                target: "http://id.who.int/icd/release/11/mms",
                element: rows.map(row => ({
                    code: row.source_code,
                    target: [{
                        code: row.target_code,
                        equivalence: row.equivalence
                    }]
                }))
            }]
        };
        res.status(200).json(conceptMap);
    } catch (error) {
        res.status(500).json({ error: "Failed to generate ConceptMap." });
    }
});


//Search Endpoint to search for Namaste Terms (here Ayurveda Only)
/**
 * @openapi
 * /search/namaste:
 * get:
 * summary: Search NAMASTE Ayurveda terms
 * description: Performs a case-insensitive search on NAMASTE Ayurveda display terms and broader terms. Requires a query parameter 'q'.
 * tags: [Search]
 * parameters:
 * - in: query
 * name: q
 * schema:
 * type: string
 * minLength: 2
 * required: true
 * description: The search term (minimum 2 characters).
 * responses:
 * 200:
 * description: An array of matching NAMASTE terms.
 * content:
 * application/json:
 * schema:
 * type: array
 * items:
 * type: object
 * properties:
 * code:
 * type: string
 * example: "AAA-1"
 * display:
 * type: string
 * example: "vAtasa~jcayaH"
 * broader_term:
 * type: string
 * nullable: true
 * icd_code:
 * type: string
 * nullable: true
 * example: "SR11"
 * 500:
 * description: Search operation failed.
 */
app.get('/search/namaste', async (req, res) => {
    const query = req.query.q;

    if (!query || query.length < 2) {
        return res.json([]);
    }

    try {
        // This upgraded query uses 'OR' to search in two different columns.
        // It also uses COALESCE to handle cases where broader_term might be null.
        const { rows } = await pool.query(
            `SELECT
                t1.code,
                t1.display,
                t1.broader_term,
                t2.target_code AS icd_code
             FROM
                namaste_ayurveda_codes AS t1
             LEFT JOIN
                namaste_icd_mappings AS t2 ON t1.code = t2.source_code
             WHERE
                t1.display ILIKE $1 OR t1.broader_term ILIKE $1
             LIMIT 10;`,
            [`%${query}%`]
        );
        
        res.status(200).json(rows);
    } catch (error) {
        console.error('Autocomplete search failed:', error);
        res.status(500).json({ error: 'Search operation failed.' });
    }
});

/**
 * [NEW HELPER]
 * Fetches rich details for a given ICD-11 code from the local WHO API service.
 * @param {string} icdCode The ICD-11 code to look up (e.g., "SR11").
 * @returns {object} An object with display, browserUrl, and foundationUri.
 */
async function getIcdDetails(icdCode) {
    // The URL uses the Docker service name 'icd11-service'
    const whoApiUrl = `http://localhost:8000/icd/release/11/mms/lookup?code=${icdCode}`;
    try {
        const response = await axios.get(whoApiUrl, {
            headers: {
                'Accept': 'application/json',
                'API-Version': 'v2',
                'Accept-Language': 'en'
            }
        });

        const data = response.data;
        return {
            display: data.title['@value'],
            browserUrl: data.browserUrl,
            foundationUri: data.source // The 'source' property holds the foundation URI
        };
    } catch (error) {
        console.error(`Failed to fetch details for ICD code ${icdCode}:`, error.message);
        return {
            display: "Official description not found.",
            browserUrl: null,
            foundationUri: null
        };
    }
}

//Search endpoint to search for ICD 11 terms 
/**
 * @openapi
 * /search/icd:
 * get:
 * summary: Search ICD-11 terms
 * description: Performs a case-insensitive search on ICD-11 titles. Requires a query parameter 'q'.
 * tags: [Search]
 * parameters:
 * - in: query
 * name: q
 * schema:
 * type: string
 * minLength: 2
 * required: true
 * description: The search term (minimum 2 characters).
 * responses:
 * 200:
 * description: An array of matching ICD-11 terms.
 * content:
 * application/json:
 * schema:
 * type: array
 * items:
 * type: object
 * properties:
 * code:
 * type: string
 * example: "5A11"
 * display:
 * type: string
 * example: "Type 2 diabetes mellitus"
 * 500:
 * description: Search operation failed.
 */
app.get('/search/icd', async (req, res) => {
    const query = req.query.q;
    if (!query || query.length < 2) return res.json([]);
    try {
        const { rows } = await pool.query(
            `SELECT code, title as display
             FROM icd11_codes_master
             WHERE title ILIKE $1
             ORDER BY code -- or ORDER BY similarity(title, $2) DESC if pg_trgm extension is enabled
             LIMIT 15;`,
            [`%${query}%` /*, query */]
        );
        res.status(200).json(rows);
    } catch (error) {
        console.error('ICD search failed:', error);
        res.status(500).json({ error: 'ICD Search failed.' });
    }
});


//Lookup Endpoint to search for Ayurveda Terms and their matching ICD 11 relatives
/**
 * @openapi
 * /lookup:
 * get:
 * summary: Lookup code details
 * description: Fetches the display name and system URI for a specific code within a given terminology system.
 * tags: [Terminology]
 * parameters:
 * - in: query
 * name: code
 * schema:
 * type: string
 * required: true
 * description: The code to look up (e.g., "SR11", "AAA-1").
 * - in: query
 * name: system
 * schema:
 * type: string
 * required: true
 * description: Identifier for the terminology system (e.g., "icd", "namaste-ayurveda").
 * responses:
 * 200:
 * description: Details found for the code.
 * content:
 * application/json:
 * schema:
 * type: object
 * properties:
 * code:
 * type: string
 * display:
 * type: string
 * system:
 * type: string
 * format: uri
 * 400:
 * description: Missing 'code' or 'system' query parameter.
 * 404:
 * description: Code not found in the specified system.
 * 500:
 * description: Lookup operation failed.
 */
app.get('/lookup', async (req, res) => {
    const { code, system } = req.query;

    if (!code || !system) {
        return res.status(400).json({ error: 'Both "code" and "system" query parameters are required.' });
    }

    try {
        let result = null;
        let systemUri = ''; // To store the canonical system URI

        if (system.toLowerCase().includes('icd')) {
            systemUri = 'http://id.who.int/icd/release/11/mms'; // Default ICD system URI
            console.log(`Lookup: Trying WHO API service for ICD code: ${code}`);
            // --- Attempt 1: Call local WHO API service ---
            const details = await getIcdDetails(code); // Calls http://icd11-service:80/...

            if (details.display && details.display !== "Official description not found.") {
                 console.log(`Lookup: Found via WHO API: ${details.display}`);
                result = { code: code, display: details.display };
            } else {
                 console.log(`Lookup: Not found via WHO API. Falling back to local DB for: ${code}`);
                // --- Attempt 2 (Fallback): Query local icd11_codes_master table ---
                const { rows } = await pool.query(
                    'SELECT code, title as display FROM icd11_codes_master WHERE code = $1 LIMIT 1',
                    [code]
                );
                if (rows.length > 0) {
                     console.log(`Lookup: Found via local DB: ${rows[0].display}`);
                    result = rows[0]; // { code, display }
                } else {
                     console.log(`Lookup: Code ${code} not found in local DB either.`);
                }
            }
        } else {
            // --- Handle NAMASTE Systems (Direct DB Query) ---
            let tableName = '';
            console.log(`Lookup: Searching local DB for NAMASTE system: ${system}, code: ${code}`);
            if (system.toLowerCase().includes('ayurveda')) {
                tableName = 'namaste_ayurveda_codes';
                systemUri = 'https://www.ayush-bridge.org/fhir/CodeSystem/namaste-ayurveda';
            } else if (system.toLowerCase().includes('siddha')) {
                tableName = 'namaste_siddha_codes';
                systemUri = 'https://www.ayush-bridge.org/fhir/CodeSystem/namaste-siddha';
            } else if (system.toLowerCase().includes('unani')) {
                tableName = 'namaste_unani_codes';
                systemUri = 'https://www.ayush-bridge.org/fhir/CodeSystem/namaste-unani';
            }
            // Add more mappings if needed

            if (tableName) {
                const { rows } = await pool.query(
                    // Fetch definition too, might be useful for display later
                    `SELECT code, display, definition FROM ${tableName} WHERE code = $1 LIMIT 1`,
                    [code]
                );
                if (rows.length > 0) {
                    result = rows[0]; // { code, display, definition }
                     console.log(`Lookup: Found NAMASTE code in ${tableName}: ${result.display}`);
                } else {
                     console.log(`Lookup: NAMASTE Code ${code} not found in ${tableName}.`);
                }
            } else {
                 console.log(`Lookup: Unknown NAMASTE system identifier: ${system}`);
            }
        }

        // --- Return Response ---
        if (result) {
            // Return the found code, display, and its canonical system URI
            res.status(200).json({ code: result.code, display: result.display, system: systemUri });
        } else {
            // If not found after all attempts
            res.status(404).json({ error: `Code "${code}" not found in system "${system}" via API or local DB.` });
        }
    } catch (error) {
        console.error(`Code lookup failed for code=${code}, system=${system}:`, error);
        res.status(500).json({ error: 'Code lookup operation failed.' });
    }
});

/**
 * --- [FULLY UPDATED] ---
 * [THE NEW HYBRID REASONING ENGINE]
 * Translates a NAMASTE code or text string to its ICD-11 equivalent.
 * 1. Tries a direct, deterministic 1-to-1 mapping.
 * 2. If no match, it calls the AI semantic search service for a recommendation.
 */
app.get('/ConceptMap/translate', async (req, res) => {
    const { code, system, text } = req.query; // Now accepts 'text' for semantic search

    if (!code && !text) {
        return res.status(400).json({ error: "Missing required parameters. Must provide 'code' or 'text'." });
    }

    try {
        // --- STEP 1: DETERMINISTIC (Human-Vetted) MAPPING ---
        if (code && system && system.includes('namaste')) {
            const { rows } = await pool.query(
                'SELECT target_code FROM namaste_icd_mappings WHERE source_code = $1', 
                [code]
            );
            
            if (rows.length > 0) {
                // ✅ Found a perfect, human-vetted match.
                return res.json({ 
                    result: true, 
                    method: "deterministic",
                    confidence: 1.0,
                    translatedCode: rows[0].target_code,
                    all_suggestions: [{ code: rows[0].target_code, score: 1.0 }]
                });
            }
        }

        // --- STEP 2: AI SEMANTIC (Probabilistic) FALLBACK ---
        // No deterministic match found, or user is searching by text.
        
        let queryText = text;

        // If user sent a code (e.g., "AAA-1") but no text, we must find its definition
        if (!queryText && code) {
            // We query the table populated by generateCodeSystem
            const { rows } = await pool.query(
                'SELECT display, definition FROM namaste_ayurveda_codes WHERE code = $1', 
                [code]
            );
            if (rows.length > 0) {
                // Use the long definition if it exists, otherwise use the display term
                queryText = rows[0].definition || rows[0].display;
            }
        }
        
        if (!queryText) {
            return res.json({ result: false, message: "No deterministic mapping found and no text available for AI search." });
        }

        // Call our new Python AI Microservice!
        // 'ai-service' is the hostname defined in our docker-compose.yaml
        console.log(`Querying AI service with text: "${queryText}"`);
        try {
            const aiResponse = await axios.post('http://ai-service:5000/semantic_search', {
                query: queryText,
                top_k: 3 // Ask for the top 3 suggestions
            });

            const suggestions = aiResponse.data.suggestions;
            if (!suggestions || suggestions.length === 0) {
                return res.json({ result: false, method: "semantic_ai", message: "AI search found no relevant mappings." });
            }

            // ✅ Found an AI-powered suggestion.
            return res.json({
                result: true,
                method: "semantic_ai",
                confidence: suggestions[0].score, // Confidence score from the AI
                translatedCode: suggestions[0].code, // The AI's best guess
                all_suggestions: suggestions // Pass all suggestions to the frontend
            });

        } catch (aiError) {
            console.error("AI service call failed:", aiError.message);
            return res.status(500).json({ error: "AI reasoning engine is offline or failed.", details: aiError.message });
        }

    } catch (error) { 
        console.error("Translation failed:", error);
        res.status(500).json({ error: "Translation failed.", details: error.message }); 
    }
});


// ---- FHIR BUNDLE INGESTION ENDPOINT ------------------------------------------------------------------------------------------------------------------
/**
 * @openapi
 * /Bundle:
 * post:
 * summary: Submit Patient and Diagnosis Data
 * description: Creates a FHIR transaction Bundle containing a Patient resource and multiple Condition resources based on the provided diagnoses. Requires JWT Authentication.
 * tags: [FHIR]
 * security:
 * - bearerAuth: [] # Reference the security scheme defined in components
 * requestBody:
 * required: true
 * content:
 * application/json:
 * schema:
 * type: object
 * required: [patient, primaryDiagnoses, secondaryDiagnoses]
 * properties:
 * patient:
 * type: object
 * properties:
 * firstName: { type: string }
 * lastName: { type: string }
 * dob: { type: string, format: date }
 * gender: { type: string, enum: [male, female, other] }
 * phone: { type: string, nullable: true }
 * address: { type: string, nullable: true }
 * primaryDiagnoses:
 * type: array
 * items:
 * type: object
 * required: [code, display, system]
 * properties:
 * code: { type: string }
 * display: { type: string }
 * system: { type: string, format: uri }
 * notes: { type: string, nullable: true }
 * secondaryDiagnoses:
 * type: array
 * items:
 * # Same schema as primaryDiagnoses items
 * type: object
 * required: [code, display, system]
 * properties:
 * code: { type: string }
 * display: { type: string }
 * system: { type: string, format: uri }
 * notes: { type: string, nullable: true }
 * responses:
 * 200:
 * description: FHIR Bundle successfully processed by HAPI FHIR (might be 201 Created depending on FHIR server response).
 * content:
 * application/fhir+json:
 * schema:
 * # Define or reference a FHIR Bundle schema here if needed
 * type: object
 * 400:
 * description: Invalid request body structure.
 * 401:
 * description: Unauthorized (Missing or invalid JWT).
 * 403:
 * description: Forbidden (Invalid JWT).
 * 500:
 * description: Failed to save bundle to FHIR server or other internal error.
 */
app.post('/Bundle', authenticateToken, async (req, res) => {
    // Note: Add validation for the request body structure
    const { patient, primaryDiagnoses, secondaryDiagnoses } = req.body;

    if (!patient || (!primaryDiagnoses && !secondaryDiagnoses) ||
        (!Array.isArray(primaryDiagnoses) || !Array.isArray(secondaryDiagnoses)) ||
        (primaryDiagnoses.length === 0 && secondaryDiagnoses.length === 0)
       ) {
        return res.status(400).json({ error: 'Missing patient data or at least one primary/secondary diagnosis array.' });
    }

    const patientId = uuidv4(); // Unique ID for this transaction's patient resource

    // --- Create FHIR Bundle ---
    const bundle = {
        resourceType: "Bundle",
        type: "transaction",
        entry: []
    };

    // 1. Patient Resource Entry
    const patientResource = {
        resourceType: "Patient",
        // id: patientId, // ID assigned by server, use fullUrl for reference
        name: [{ given: [patient.firstName], family: patient.lastName }],
        gender: patient.gender?.toLowerCase(), // Handle potentially missing gender
        birthDate: patient.dob,
        telecom: patient.phone ? [{ system: "phone", value: patient.phone }] : undefined,
        address: patient.address ? [{ text: patient.address }] : undefined
    };
    bundle.entry.push({
        fullUrl: `urn:uuid:${patientId}`,
        resource: patientResource,
        request: { method: "POST", url: "Patient" }
    });

    // Helper function to create a Condition resource entry
    const createConditionEntry = (diagnosis, index, isPrimary = true) => {
        if (!diagnosis || !diagnosis.code || !diagnosis.display || !diagnosis.system) {
            console.warn(`Skipping invalid diagnosis at index ${index} (Primary: ${isPrimary}):`, diagnosis);
            return null; // Skip invalid entries
        }
        const conditionResource = {
            resourceType: "Condition",
            clinicalStatus: {
                coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }]
            },
            verificationStatus: {
                coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }]
            },
            // Use category to distinguish if needed, 'encounter-diagnosis' is common
            category: [{
                coding: [{
                    system: "http://terminology.hl7.org/CodeSystem/condition-category",
                    code: "encounter-diagnosis", // or "problem-list-item" for secondary?
                    display: "Encounter Diagnosis"
                }]
            }],
            code: {
                coding: [{
                    system: diagnosis.system, // System URI provided by frontend
                    code: diagnosis.code,
                    display: diagnosis.display
                }],
                // Optionally add original text if available
                // text: diagnosis.display
            },
            subject: { reference: `urn:uuid:${patientId}` }, // Reference the patient in this bundle
            // Add clinical notes if provided
            note: diagnosis.notes ? [{ text: diagnosis.notes }] : undefined,
            // You might add recordedDate, onsetDateTime etc. if available
            // recordedDate: new Date().toISOString()
        };

        return {
            // fullUrl: `urn:uuid:${uuidv4()}`, // Each resource needs a unique URN if referenced later in bundle
            resource: conditionResource,
            request: { method: "POST", url: "Condition" }
        };
    };

    // 2. Primary Condition Resource Entries
    primaryDiagnoses.forEach((diag, index) => {
        const entry = createConditionEntry(diag, index, true);
        if (entry) bundle.entry.push(entry);
    });

    // 3. Secondary Condition Resource Entries
    secondaryDiagnoses.forEach((diag, index) => {
        const entry = createConditionEntry(diag, index, false);
        if (entry) bundle.entry.push(entry);
    });

    // 4. Post the Bundle to the HAPI FHIR server
    try {
        const hapiFhirUrl = process.env.HAPI_FHIR_URL || 'http://hapi-fhir:8080/fhir'; 
        console.log(`Posting Bundle to HAPI FHIR: ${hapiFhirUrl}`);
        const response = await axios.post(hapiFhirUrl, bundle, {
            headers: { 'Content-Type': 'application/fhir+json' } 
        });
        console.log('HAPI FHIR Response Status:', response.status);
        res.status(response.status).json(response.data); 
    } catch (error) {
        console.error('Failed to post Bundle to HAPI FHIR server:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        // Provide more detailed error feedback if possible
        const status = error.response?.status || 500;
        const details = error.response?.data?.issue?.[0]?.diagnostics || error.message;
        res.status(status).json({ error: "Failed to save the patient record to FHIR server.", details: details });
    }
});




// --- 5. API Swagger ---------------------------------------------------------------------------------------
const swaggerOptions = {
  definition: {
    openapi: '3.0.0', // Specify OpenAPI version
    info: {
      title: 'AYUSH-BRIDGE API',
      version: '1.0.0',
      description: 'API service for mapping AYUSH terminologies (NAMASTE) to ICD-11, managing patient data, and providing terminology search/lookup.',
      contact: {
        name: 'API Support', // Optional
        // url: 'http://www.example.com/support', // Optional
        // email: 'support@example.com', // Optional
      },
    },
    servers: [
      {
        url: `http://localhost:${port}`, // Your API server URL
        description: 'Development server',
      },
      // You can add more servers (e.g., staging, production) here
    ],
    // Optional: Define security schemes if using JWT authentication on more endpoints
    // components: {
    //   securitySchemes: {
    //     bearerAuth: {
    //       type: 'http',
    //       scheme: 'bearer',
    //       bearerFormat: 'JWT',
    //     }
    //   }
    // },
    // security: [{ // Apply security globally (or specify per-path)
    //   bearerAuth: []
    // }],
  },
  // Path to the API docs files (here, it's this server.js file itself)
  apis: ['./server.js'], // Or ['./routes/*.js'] if you split routes
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));


// --- 6. START SERVER ---------------------------------------------------------------------------------------
app.listen(port, '0.0.0.0', () => { // Listen on all interfaces for Docker
    console.log(`🚀 AYUSH-BRIDGE backend service listening at http://localhost:${port}`);
    console.log(`📚 API Docs available at http://localhost:${port}/api-docs`);
    console.log('Endpoints:');
    console.log(` -> GET /codesystem/{ayurveda|siddha|unani}`);
    console.log(` -> POST /ingest/all-knowledge   (Admin: Run once)`);
    console.log(` -> GET /search/namaste?q=term   (Autocomplete Ayurveda)`);
    console.log(` -> GET /search/icd?q=term       (Autocomplete ICD-11)`);
    console.log(` -> GET /lookup?code=X&system=Y  (Fetch details by code)`);
    console.log(` -> GET /ConceptMap/translate    (Hybrid translation)`);
    console.log(` -> POST /Bundle                 (Submit Patient + Diagnoses)`);
});

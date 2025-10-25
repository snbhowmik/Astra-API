// AYUSH-BRIDGE: Backend Terminology Service
// File: backend/server.js

// --- 1. IMPORTS AND SETUP ---
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const csv = require('csv-parser');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const app = express();
app.use(cors());
app.use(express.json());
const port = 3000;

// --- 2. DATABASE CONNECTION ---
// The Pool automatically uses the environment variables (DB_HOST, DB_USER, etc.)
// defined in your docker-compose.yaml to connect to the PostgreSQL container.
const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});
console.log('Attempting to connect to PostgreSQL database...');
pool.connect()
    .then(client => {
        console.log('✅ Successfully connected to PostgreSQL database.');
        client.release();
    })
    .catch(err => {
        console.error('❌ Error connecting to PostgreSQL database:', err.stack);
    });

// --- 3. REUSABLE CODESYSTEM GENERATOR FUNCTION ---


/**
 * [HELPER FUNCTION - 1 NAMASTE CODE EXTRACTION]
 * @param {string} inputString The raw string from the CSV.
 * @returns {string|null} The clean NAMASTE code, or the original if no specific pattern is found.
 */
function extractNamasteCode(inputString) {
    if (!inputString || typeof inputString !== 'string') {
        return null;
    }

    // A regex that matches EITHER the alphanumeric format OR the pure alphabetic format.
    // ^ and $ ensure it matches the whole token, not just a part of it.
    const namastePattern = /(^[A-Z]{3}-\d+$)|(^[A-Z]{1,3}$)/;

    // Clean the string by replacing parentheses and splitting it into parts.
    // e.g., "SR11 (AAA-1)" becomes ["SR11", "AAA-1"]
    const potentialCodes = inputString.replace(/[()]/g, ' ').trim().split(/\s+/);

    // Find the first part that matches our comprehensive NAMASTE pattern.
    for (const code of potentialCodes) {
        if (namastePattern.test(code)) {
            return code; // Return the first valid NAMASTE code found
        }
    }

    // If no specific pattern was found after checking all parts,
    // return the first part of the original string as a fallback.
    return potentialCodes[0] || null;
}

/**
 * [HELPER 2 - Extracts BOTH NAMASTE and ICD codes if they exist in the same string]
 */
function extractMappingCodes(inputString) {
    if (!inputString || typeof inputString !== 'string') return { namasteCode: null, icdCode: null };
    const parts = inputString.replace(/[()]/g, ' ').trim().split(/\s+/).filter(p => p);
    if (parts.length < 2) {
        // Handle cases like 'BB' or 'AAB-15' that are not mappings
        const namastePattern = /(^[A-Z]{3}-\d+$)|(^[A-Z]{1,3}$)/;
        if(namastePattern.test(parts[0])) return { namasteCode: parts[0], icdCode: null };
        return { namasteCode: parts[0] || null, icdCode: null };
    }
    const icdPattern = /^[A-Z]{2}\d+/;
    let icdCode = null; let namasteCode = null;
    for (const part of parts) {
        if (icdPattern.test(part)) icdCode = part;
        else namasteCode = part;
    }
    return { namasteCode, icdCode };
}

/**
 * [FINAL & COMPLETE FUNCTION]
 * Reads the entire CSV into memory, then inserts all data into the DB
 * within a single transaction to ensure reliability and data integrity.
 * Creates a rich, standardized FHIR CodeSystem resource.
 * @param {object} config - Configuration object for the generation process.
 * @returns {Promise<object>} A Promise that resolves to a FHIR CodeSystem JSON object.
 */
async function generateCodeSystem(config) {
    const { tableName, csvFilePath, codeSystemId, codeSystemName, csvCodeColumn, csvDisplayColumn } = config;

    // Create all necessary tables if they don't exist
    await pool.query(`CREATE TABLE IF NOT EXISTS ${tableName} (id SERIAL PRIMARY KEY, code VARCHAR(50) UNIQUE NOT NULL, display TEXT, definition TEXT, broader_term TEXT);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS namaste_icd_mappings (id SERIAL PRIMARY KEY, source_system TEXT, source_code TEXT, target_system TEXT, target_code TEXT, UNIQUE(source_code, target_code));`);
    
    const csvRows = [];
    await new Promise((resolve, reject) => {
        fs.createReadStream(csvFilePath).pipe(csv()).on('data', (data) => csvRows.push(data)).on('end', resolve).on('error', reject);
    });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const row of csvRows) {
            const rawCode = row[csvCodeColumn];
            const display = row[csvDisplayColumn];
            const definition = row['Long_definition'] || row['Short_definition'];
            const { namasteCode, icdCode } = extractMappingCodes(rawCode);

            if (namasteCode && display) {
                const broaderTerm = row['Ontology_branches']; // Get the English term
//...
                await client.query(`INSERT INTO ${tableName} (code, display, definition, broader_term) VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO UPDATE SET display = EXCLUDED.display, definition = EXCLUDED.definition, broader_term = EXCLUDED.broader_term;`, [namasteCode, display, definition, broaderTerm]);
            }
            if (namasteCode && icdCode) {
                await client.query(`INSERT INTO namaste_icd_mappings (source_system, source_code, target_system, target_code) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING;`, [`https://www.ayush-bridge.org/fhir/CodeSystem/${codeSystemId}`, namasteCode, 'http://id.who.int/icd/release/11/mms', icdCode]);
            }
        }
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK'); throw e;
    } finally {
        client.release();
    }

    // The MASTER QUERY: Join all three tables to get the final data
    const { rows } = await pool.query(`
        SELECT t1.code, t1.display, t1.definition, t2.target_code AS icd_code, t3.foundation_uri, t3.linearization_url
        FROM ${tableName} AS t1
        LEFT JOIN namaste_icd_mappings AS t2 ON t1.code = t2.source_code
        LEFT JOIN icd11_codes_master AS t3 ON t2.target_code = t3.code
        ORDER BY t1.code;
    `);

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

// --- 4. API ENDPOINTS ---

app.get('/', (_req, res) => {
    res.send('AYUSH-BRIDGE Terminology Service is running. Use the /codesystem/[system] endpoints.');
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

// --- [NEW] ADMIN ENDPOINT TO INGEST ALL SAT KNOWLEDGE ---
/**
 * [NEW HELPER]
 * Generic function to ingest a standard SAT table.
 */
async function ingestSatTable(client, csvPath, tableName) {
    console.log(`Ingesting ${csvPath} into ${tableName}...`);
    await client.query(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
            id SERIAL PRIMARY KEY,
            code TEXT UNIQUE,
            parent_id TEXT,
            word TEXT,
            short_defination TEXT,
            long_defination TEXT,
            reference TEXT
        );
    `);
    
    const rows = [];
    await new Promise((resolve, reject) => {
        fs.createReadStream(csvPath).pipe(csv())
          .on('data', (data) => rows.push(data))
          .on('end', resolve).on('error', reject);
    });

    for (const row of rows) {
        await client.query(
            `INSERT INTO ${tableName} (code, parent_id, word, short_defination, long_defination, reference)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (code) DO NOTHING;`,
            [row.Code, row.parent_id, row.Word, row.Short_Defination, row.Long_Defination, row.reference]
        );
    }
    console.log(`✅ Finished ingesting ${tableName}.`);
    return rows.length;
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

/**
 * [SUBMISSION ENDPOINT]
 * Receives patient and diagnosis data, creates a FHIR Bundle,
 * and posts it to the HAPI FHIR server for persistent storage.
 */
app.post('/Bundle', authenticateToken, async (req, res) => {
    const { patient, namasteDiagnosis, icdDiagnosis } = req.body;

    if (!patient || !namasteDiagnosis) {
        return res.status(400).json({ error: 'Missing patient or diagnosis data.' });
    }

    // Generate a unique ID for the patient within this transaction
    const patientId = uuidv4();

    // 1. Create the FHIR Patient resource
    const patientResource = {
        resourceType: "Patient",
        name: [{
            given: [patient.firstName],
            family: patient.lastName
        }],
        gender: patient.gender.toLowerCase(),
        birthDate: patient.dob,
        telecom: [{ system: "phone", value: patient.phone }],
        address: [{ text: patient.address }]
    };

    // 2. Create the FHIR Condition resource with dual-coding
    const conditionResource = {
        resourceType: "Condition",
        // This reference now uses the correct urn:uuid format
        subject: { reference: `urn:uuid:${patientId}` },
        code: {
            text: namasteDiagnosis.display,
            coding: [
                {
                    system: "https://www.ayush-bridge.org/fhir/CodeSystem/namaste-ayurveda",
                    code: namasteDiagnosis.code,
                    display: namasteDiagnosis.display
                }
            ]
        }
    };

    if (icdDiagnosis && icdDiagnosis.code) {
        conditionResource.code.coding.push({
            system: "http://id.who.int/icd/release/11/mms",
            code: icdDiagnosis.code,
            display: icdDiagnosis.display
        });
    }

    // 3. Create the final, standards-compliant FHIR Bundle
    const bundle = {
        resourceType: "Bundle",
        type: "transaction",
        entry: [
            {
                // The fullUrl also uses the correct urn:uuid format
                fullUrl: `urn:uuid:${patientId}`,
                resource: patientResource,
                request: {
                    method: "POST",
                    url: "Patient"
                }
            },
            {
                resource: conditionResource,
                request: {
                    method: "POST",
                    url: "Condition"
                }
            }
        ]
    };

    // 4. Post the Bundle to the HAPI FHIR server
    try {
        const hapiFhirUrl = 'http://hapi-fhir:8080/fhir';
        const response = await axios.post(hapiFhirUrl, bundle);
        res.status(201).json(response.data);
    } catch (error) {
        console.error('Failed to post Bundle to HAPI FHIR server:', error.response ? error.response.data.issue : error.message);
        res.status(500).json({ error: "Failed to save the patient record." });
    }
});


// --- 5. START SERVER ---
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 AYUSH-BRIDGE backend service listening at http://localhost:${port}`);
    console.log('Available endpoints:');
    console.log(`  -> GET http://localhost:${port}/codesystem/ayurveda`);
    console.log(`  -> GET http://localhost:${port}/codesystem/siddha`);
    console.log(`  -> GET http://localhost:${port}/codesystem/unani`);
    console.log(`  -> POST http://localhost:${port}/ingest/all-knowledge  <-- [NEW] Run this once!`);
    console.log(`  -> GET http://localhost:${port}/ConceptMap/translate   <-- [UPDATED]`);
});
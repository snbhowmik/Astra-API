import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer
import chromadb
import os

# --- 1. Setup ---

# Create the FastAPI app
app = FastAPI(title="AYUSH-BRIDGE AI Reasoning Engine")

# Define the local, persistent path for our vector database
# This is the same folder we mount in docker-compose.yaml
DB_PATH = "./vector-store"
if not os.path.exists(DB_PATH):
    os.makedirs(DB_PATH)

# Load the AI model (this will download     it on first run)
# 'all-MiniLM-L6-v2' is a great, fast model for semantic search.
print("Loading semantic model...")
model = SentenceTransformer('all-MiniLM-L6-v2')
print("Model loaded successfully.")

# Initialize the vector database client
# This client saves data to the DB_PATH folder
client = chromadb.PersistentClient(path=DB_PATH)

# Get or create our "collection" (like a table)
# We specify "cosine" so the distances are based on semantic similarity
collection = client.get_or_create_collection(
    name="icd11_embeddings",
    metadata={"hnsw:space": "cosine"} 
)

# --- 2. Define Data Models (for API requests) ---

class AddDocument(BaseModel):
    id: str   # e.g., "1A00"
    text: str # e.g., "Cholera"

class SearchQuery(BaseModel):
    query: str
    top_k: int = 3

# --- 3. Define API Endpoints ---

@app.get("/")
def read_root():
    return {"status": "AI Reasoning Engine is running."}

@app.post("/add-embedding")
def add_embedding(doc: AddDocument):
    """
    Receives a new ICD-11 code, creates its embedding, 
    and adds it to the vector database.
    """
    if not doc.text or not doc.id:
        return {"status": "error", "message": "id and text are required"}

    # 1. Create the vector embedding
    embedding = model.encode([doc.text]).tolist()

    # 2. Add it to the collection
    collection.add(
        ids=[doc.id],
        embeddings=embedding,
        documents=[doc.text]
    )

    return {"status": "success", "id": doc.id, "text": doc.text}


@app.post("/semantic_search")
def semantic_search(query: SearchQuery):
    """
    Receives a text query, embeds it, and finds the 
    'top_k' closest matches from the vector database.
    """
    # 1. Create the vector for the search query
    query_embedding = model.encode([query.query]).tolist()

    # 2. Query the collection
    results = collection.query(
        query_embeddings=query_embedding,
        n_results=query.top_k
    )

    # 3. Format the results
    ids = results['ids'][0]
    distances = results['distances'][0]
    
    # Convert 'distance' (0.0=close, 1.0=far) to 'similarity_score' (1.0=close, 0.0=far)
    suggestions = []
    for id, dist in zip(ids, distances):
        suggestions.append({
            "code": id,
            "score": 1.0 - dist # Convert distance to similarity
        })

    return {"suggestions": suggestions}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5000)
---
description: Contextual search in the document base using embeddings
---

# RAG Search Workflow

This workflow performs intelligent searches over the indexed document base
using embeddings and semantic search.

## Usage

Type `/rag-search` followed by the term you want to search.

## Examples

- `/rag-search machine learning`
- `/rag-search neural networks`
- `/rag-search data science`

## What Happens

1. **Embedding generation:** the search term is converted into a numeric vector
   using Ollama.
2. **Semantic search:** the system finds documents with similar meanings.
3. **Ranking:** results are ordered by relevance and similarity.
4. **Presentation:** the top five results are displayed with context.

## Results

Each result includes:

- document name;
- specific page;
- relevant excerpt;
- similarity score;
- options for deeper exploration.

## Tips

- Use specific technical terms for better results.
- Try synonyms or related concepts.
- Vary the terms if no results are found.

## Configuration

This workflow uses the `rag-local` MCP server, which must be configured in
Windsurf.

---
description: Search indexed documents and return PDF-aware results
---

# RAG PDF Search Workflow

This workflow searches the indexed document base and returns results with PDF
location context whenever available.

## Usage

Type `/rag-search-pdf` followed by the search term.

## Examples

- `/rag-search-pdf "attention mechanism"`
- `/rag-search-pdf "gradient descent"`
- `/rag-search-pdf "software architecture"`

## What Happens

1. The query is converted into an embedding.
2. Semantic search finds relevant chunks.
3. Results are ranked by similarity.
4. PDF page, document, and excerpt details are returned when available.

## Result Shape

- **Document:** source document name.
- **Page:** page number when available.
- **Excerpt:** relevant matched text.
- **Score:** semantic similarity score.
- **PDF link:** link or action to open the PDF when supported.

## Related Commands

- `/rag-search` - general contextual search.
- `/rag-find-page` - find pages by quoted text.
- `rag_open_pdf` - open a PDF directly when supported.
- `rag_list_books` - list indexed books.

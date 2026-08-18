---
description: Finds specific pages in books based on text
---

# Specific Page Search Workflow

This workflow finds specific pages in books by searching quoted text. Numeric
queries are treated as text so the system does not confuse a written number
with a page number.

## Usage

Type `/rag-find-page` followed by quoted text.

## Examples

- `/rag-find-page "convolutional neural networks"`
- `/rag-find-page "machine learning algorithms"`
- `/rag-find-page "attention mechanism"`
- `/rag-find-page "42"` searches for the text `42`, not page 42.

## What Happens

1. **Query analysis:** identifies the text to search.
2. **Smart search:** uses semantic and textual search to find relevant pages.
3. **Interactive menu:** when multiple results exist, presents numbered options.
4. **Selection and retrieval:** retrieves the selected page content.
5. **Rich context:** presents the full page content for chat use.

## Interactive Menu

When multiple pages are found, the system presents numbered options with the
book name, page number, and excerpt. The user can choose a number or request all
results.

## Additional Options

- **Open PDF:** opens the document on the specific page.
- **Copy content:** copies the text to the clipboard.
- **Find similar:** finds other pages with similar content.
- **View context:** shows previous and following pages.

## Filters

- `book:"name"` - search only in a specific book.
- `page:X-Y` - search within a page range.
- `similar:0.8` - adjust the similarity threshold.

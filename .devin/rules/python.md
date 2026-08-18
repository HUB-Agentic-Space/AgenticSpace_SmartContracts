---
trigger: always_on
---
# Python Rule

Use clear, maintainable Python with explicit dependencies and predictable
runtime behavior.

Rules:

- Prefer type hints for public functions and service boundaries.
- Keep functions small enough to test.
- Use structured logging instead of ad hoc prints in application code.
- Validate external input before use.
- Handle file paths with `pathlib` where practical.
- Keep secrets in environment variables, never in source code.
- Run targeted tests after code changes.

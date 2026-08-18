![visitors](https://visitor-badge.laobi.icu/badge?page_id=carlosdelfino.openclaw-skill-calibre-ebooks)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: English](https://img.shields.io/badge/Language-English-brightgreen.svg)
![Workflow](https://img.shields.io/badge/Workflow-PDCL-blue)
![Python](https://img.shields.io/badge/Python-3.8%2B-blue)
![Status](https://img.shields.io/badge/Status-Development-brightgreen)

---
description: Applies the PDCL methodology with GenAI for iterative development
---

# PDCL Workflow - Plan, Do, Check Logs

PDCL adapts the traditional PDCA cycle for generative AI assisted software
development. Structured logs are the central validation and communication
mechanism between the system and the AI.

## Usage

Type `/pdcl` followed by the task or feature to develop.

## Examples

- `/pdcl create a temperature monitoring system`
- `/pdcl implement a REST API for users`
- `/pdcl add JWT authentication`
- `/pdcl optimize query performance`

## The PDCL Cycle

### 1. Plan

- Create or update `REQUIREMENTS.md` with functional and non-functional
  requirements.
- Define expected behavior clearly, testably, and in a way AI can interpret.
- Refine and organize requirements with AI support.
- Document constraints, limits, and error scenarios.

### 2. Do

- Produce code based on the defined requirements.
- Instrument code with structured logs from the start.
- Use the log pattern:
  `[YYYY-MM-DD HH:MM:SS] [file:function:line] emoji message - relevant_parameters`.
- Use specific markers: info, warning, error, completed, debug, start, and end.

### 3. Check Logs

- Run the application automatically.
- Collect logs generated during execution.
- Analyze logs with AI and compare observed behavior against requirements.
- Identify divergences, inconsistencies, and failures.
- Verify scenario coverage and error handling.

### 4. Iterative Loop

- Based on log analysis, AI proposes code fixes.
- Adjust requirements when needed.
- Improve log instrumentation.
- Run again and repeat until validation is complete.

## Principles

- **Observability:** all behavior must be observable through logs.
- **Continuous iteration:** the cycle repeats until validation is complete.
- **Human-AI coauthorship:** requirements are refined collaboratively.
- **Semantic validation:** AI checks behavior, not just syntax.
- **Closed-loop control:** the system improves based on feedback.

---
**Summary:** PDCL workflow with GenAI for iterative software development using structured logs as the central validation element.
**Creation Date:** 2026-05-08
**Author:** Carlos Delfino
**Version:** 1.1
**Last Update:** 2026-05-22
**Updated by:** Carlos Delfino
**Changelog:**
- 2026-05-22 - Updated by Carlos Delfino - Added badges, animated header, and animated footer following the new documentation rules - Version 1.1
- 2026-05-08 - Created by Carlos Delfino - Version 1.0

# Sarva — default document templates

This folder holds **starter templates** for governed deliverables. They serve two purposes:

1. **Product requirement:** Sarva shall ship (or mirror) a **templates library** so humans and agents can create **FRD, BRD, HLD, LLD**, and similar documents with consistent structure (see **[`../SARVA-REQUIREMENTS.md`](../SARVA-REQUIREMENTS.md)**, §9.14, SARVA-FR-126–130).
2. **This repository:** Use these files as **canonical examples** and as **grounding context** when implementing or extending Sarva.

## Files

| Template | Purpose |
|----------|---------|
| [FRD-template.md](FRD-template.md) | Functional Requirements Document |
| [BRD-template.md](BRD-template.md) | Business Requirements Document |
| [HLD-template.md](HLD-template.md) | High-Level Design |
| [LLD-template.md](LLD-template.md) | Low-Level Design |
| [PRD-template.md](PRD-template.md) | Product Requirements Document (optional bridge between BRD and FRD) |

**Customization:** Tenants may override templates in their connected **document repository**; platform defaults apply when no override exists.

## Usage

- Copy the relevant template when starting a new document; replace `{{placeholders}}` and remove unused sections.
- Agents should **cite** which template version was used when producing a deliverable (audit trail).

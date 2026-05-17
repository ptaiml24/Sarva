# {{SYSTEM_NAME}} — High-Level Design (HLD)

**Version:** {{x.y}}  
**Status:** Draft | Review | Approved  
**Authors:** {{names}}  
**Related BRD/FRD:** {{links or ids}}  

---

## 1. Purpose and scope

- **What** this HLD covers (system or subsystem boundary).  
- **References:** FRD IDs, constraints, NFRs.  

---

## 2. Context

### 2.1 System context (C4 Level 1)

*Insert diagram or bullet list: Sarva as a box; users; external systems (LLM providers, email, Git, Jira, …).*

### 2.2 Goals and quality attributes

- Performance, security, availability, scalability (targets).  

---

## 3. Architecture overview

### 3.1 Logical components

| Component | Responsibility | Notes |
|-----------|----------------|--------|
| Control plane UI | … | |
| System orchestrator | … | |
| Agent runtime | … | |
| … | … | |

### 3.2 Deployment view (logical)

- SaaS vs self-hosted; regions; tenancy (single vs multi-company). *TBD as applicable.*  

---

## 4. Major data flows

Describe 3–5 critical flows (e.g. Task execution, approval gate, Email Agent send, MCP tool call).

---

## 5. Integrations

| External system | Direction | Protocol | Notes |
|-----------------|-----------|----------|--------|
| … | In/Out/Both | REST/MCP/… | |

---

## 6. Security and compliance (high level)

- Authentication/authorization model (RBAC tiers).  
- Data isolation (tenant).  
- Secrets handling (reference; detail in security spec).  
- Audit logging (what must be captured).  

---

## 7. Technology constraints

- Languages, frameworks, **must-use** services.  

---

## 8. Open issues

---

## 9. Approval

| Role | Name | Date |
|------|------|------|
| Architecture | | |
| Security | | |

---

## Document history

| Version | Date | Notes |
|---------|------|--------|
| 0.1 | | |

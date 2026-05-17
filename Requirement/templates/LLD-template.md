# {{COMPONENT_OR_SERVICE}} — Low-Level Design (LLD)

**Version:** {{x.y}}  
**Status:** Draft | Review | Approved  
**Author:** {{name}}  
**Parent HLD:** {{link or section}}  

---

## 1. Purpose and scope

- **Component** name and **boundaries** (what is in / out of this LLD).  
- **FRD/HLD** traceability (IDs).  

---

## 2. Interfaces

### 2.1 External APIs (this component)

| Endpoint / queue / event | Method | Request | Response | Errors |
|--------------------------|--------|---------|----------|--------|
| … | … | … | … | … |

### 2.2 Dependencies

- Other services, DBs, queues this component calls.  

---

## 3. Data model (detailed)

### 3.1 Entities / tables / documents

| Name | Fields | Keys | Indexes | Notes |
|------|--------|------|---------|--------|
| … | … | … | … | … |

### 3.2 Migrations / versioning

---

## 4. Algorithms and workflows

- State machines, orchestration steps, retry policy.  

---

## 5. Configuration

- Feature flags, env vars, per-tenant settings.  

---

## 6. Error handling and observability

- Error codes; logging; metrics; tracing (correlation IDs).  

---

## 7. Security

- Input validation; authZ checks; PII handling for this component.  

---

## 8. Performance and limits

- Rate limits; batch sizes; timeouts.  

---

## 9. Testing strategy

- Unit, integration, contract tests; key scenarios.  

---

## 10. Open issues

---

## Approval

| Role | Name | Date |
|------|------|------|
| Engineering lead | | |

---

## Document history

| Version | Date | Notes |
|---------|------|--------|
| 0.1 | | |

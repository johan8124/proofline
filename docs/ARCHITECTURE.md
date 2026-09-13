# Proofline Architecture

## Overview

Proofline separates factual verification from AI explanation.

Deterministic application code performs the submission checks and produces the authoritative readiness state and evidence. The Strands agent receives those verified facts and explains them to the user. The agent does not determine or overwrite the verification result.

## Architecture

```mermaid
flowchart TD
    U[User] --> UI[Next.js UI]
    UI --> API[POST /api/preflight]
    API --> TMP[Temporary server-side PDF]
    TMP --> PF[runPreflight]

    PF --> PDF[Deterministic PDF Verification]
    PF --> REPO[Deterministic Repository Verification]

    PDF --> LEDGER[Evidence Ledger]
    REPO --> LEDGER

    LEDGER --> READY[ReadinessResult]

    READY --> FACTS[Verified Facts]
    FACTS --> AGENT[Strands Agent via Groq]
    AGENT --> EXPLAIN[Agent Explanation]

    READY --> UI
    LEDGER --> UI
    EXPLAIN --> UI
```

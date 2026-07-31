# Mermaid diagram

Mermaid code blocks turn text into diagrams. The source remains readable and easy to revise.

```mermaid
flowchart LR
  Capture[Capture an observation] --> Connect[Link related notes]
  Connect --> Decide{Decision needed?}
  Decide -->|Yes| Record[Record the decision]
  Decide -->|No| Review[Include in review]
  Record --> Review
  Review --> Act[Choose the next action]
```

This flow mirrors the relationships between [[Examples/Work/meeting-notes|Meeting notes]], [[Examples/Work/decision-log|Decision log]], and [[Examples/Personal/weekly-review|Weekly review]].

## When diagrams help

Use a diagram for sequence, branching, or ownership that becomes hard to follow in prose. A short list is still the clearest choice for a simple linear procedure.

#feature/diagram #demo

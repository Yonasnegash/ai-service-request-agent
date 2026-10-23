
### Future state — proposed automation

1. Receive the email, validate its basic structure, and register it with a unique case ID.
2. Use the AI classifier to summarize the request, identify category candidates, and extract relevant fields.
3. Validate the model output against the approved schema and business rules.
4. Apply the decision policy:- Complete and routine: retrieve permitted policy information where needed, determine the appropriate team, and route the case.
   - Incomplete: record missing information and route for human follow-up; the agent does not send customer replies in the MVP.
   - Ambiguous, sensitive, or invalid: flag for human review or general triage as appropriate.
5. Record the outcome, classification and policy versions, errors, audit events, and processing metrics.
6. Employee investigates, communicates with the customer, resolves the case, and closes it.

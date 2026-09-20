# Result codes

A run ends in exactly one of three statuses. `success` carries the declared outputs, `business_outcome` carries a code and a message the caller must handle, and `failure` carries a `RunError` with the step, what was expected, what was observed and the evidence files.

## Business outcome codes seen in the evidence

| Code | Origin | Meaning |
|---|---|---|
| `MEMBER_NOT_FOUND` | learned by a probe | The inquiry returned no member for the supplied member number. |
| `PERMISSION_DENIED` | app profile | The operator is not authorised to view the record (restricted account). |
| `VALIDATION_ERROR` | learned by a probe | The application rejected the submitted values (for example a deposit below the minimum). |
| `DUPLICATE_INVOCATION` | idempotency ledger | An earlier invocation with the same idempotency key already posted the irreversible step; the earlier outputs are returned and nothing is posted again. |

## Failure codes

| Code | When |
|---|---|
| `INVALID_INPUT` | Inputs do not satisfy the artifact contract; the browser is never touched. |
| `PRECONDITION_FAILED` | The screen is not the one the step expects before acting (wrong page, unknown state). |
| `TARGET_NOT_FOUND` / `TARGET_AMBIGUOUS` | No strategy produced exactly one visible match within the step timeout (after assist, if enabled). |
| `EXPECTATION_FAILED` / `CHECKPOINT_FAILED` | A post-condition or the final checkpoint did not hold and no condition explains the state. |
| `UNEXPECTED_DIALOG` | A JavaScript dialog appeared that the step did not record; it was dismissed, never accepted. |
| `APP_ERROR` | The application error page persisted after the configured retries. |
| `SESSION_LOST` | Sign-on did not produce an authenticated session (bad credentials, locked account). |
| `POLICY_BLOCKED` | The policy gate denied the action, an operator denied it, or the irreversible cap was reached. |
| `HUMAN_ABORTED` / `ESCALATION_TIMEOUT` / `ESCALATION_UNAVAILABLE` | The operator aborted, nobody answered in time, or no operator console was attached. |
| `UNKNOWN_STATE` | A hard-failure condition matched, a recovery would be unsafe after a mutation, or an unresolved ledger intent needs a human to check the system of record. |
| `TIMEOUT` / `MAX_STEPS` / `AGENT_GAVE_UP` / `LLM_ERROR` | Discovery budgets and model errors. |
| `NAVIGATION_ERROR` / `SURFACE_ERROR` / `OUTPUT_PARSE_ERROR` | Infrastructure and parsing problems, reported with the raw value or cause. |

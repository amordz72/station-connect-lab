# Station Connect Lab — safe, public transport tests

A **public, test-only snapshot** of selected nonfinancial/generic transport code from Station Connect. No operational station identity, local configuration, Supabase deployment, database migrations, secrets, authenticators, customer inventory or historic Git commits are copied here.

## What is included
- `src/command-executor.js`: generic command transport and technical results
- `src/hilink-ussd.js`: modem HTTP/USSD transport
- `src/windows-service-code.js`: Windows transport helper
- `src/hardware-verification.js`: read-only USB/SIM identity consistency
- `tests/*.test.js`: mocked tests and safe source checks

All tests use synthetic values; **they must never contact a real modem**, start an Agent, enroll a station, call Supabase, or send financial instructions. There is no `Agent` startup script.

## Run
Requires Node.js 22+:
```shell
npm test
npm run check
```
GitHub Actions: `Agent Transport Lab` runs on a standard hosted Linux runner; manual dispatch is also available. Checks only local mocks and source syntax.

## Boundaries
This is not the deployable Station Connect Agent, not a usable station, and **not proof that 632 works in production**. No backend SQL/Gateway source is shipped or tested here. The actual system remains behind authenticated server-owned command decisions and per-station secrets. Any changes must be reviewed separately before applying to the private origin.

The public snapshot may need regular source parity refreshes after private source changes. A green lab check **does not authorize a modem command or a financial transfer**.

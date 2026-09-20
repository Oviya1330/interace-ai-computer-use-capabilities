# Computer-use automation for legacy bank software

This repo is a small but complete version of the system described in the take-home brief, so an LLM drives a real application surface once to accomplish a goal, the successful run is recorded as a typed and versioned capability artifact, and from then on the artifact is replayed deterministically with no model in the decision loop, with an explicit error taxonomy, safety guardrails, and a real handoff to a human operator who can take over the same live browser session when the automation is stuck. The target is a mock legacy core-banking teller console that I built to be deliberately hostile (framesets, table layouts, no ids or labels or ARIA, links that navigate through inline JavaScript, a confirm() dialog on the irreversible step), and it can inject the runtime faults the brief cares about, so session expiry, interstitial notices, HTTP 500 pages, slow loads, record not found, permission denied and validation errors are all reproducible on demand. The design write-up is in [REPORT.md](REPORT.md), the run evidence with an HTML report per run is in [evidence/](evidence/README.md), and the result codes are in [docs/errors.md](docs/errors.md).

The stack is TypeScript on Node 20 or newer, Playwright (Chromium) as the surface, Zod for the artifact schema, Express for the mock app and the operator console, and the Anthropic SDK for the discovery model (Claude Opus 5 by default). Everything runs in one process on your machine, there are no cloud services apart from the model API, and replay never calls the model unless you explicitly enable the bounded assisted recovery described below.

## What is in the box

The surface layer (`src/surface`) perceives a page as a screenshot with numbered marks plus an element index that an injected script builds inside every frame, including framesets, with computed roles, accessible names, legacy-style labels read from the adjacent table cell, table context (headers, row values, column) and structural paths, and it acts through DOM handles when they exist and through coordinates otherwise, so the same seam could be implemented on top of an OS accessibility tree for a desktop app. Fields the app profile classifies as sensitive (SSN, card numbers) are blacked out in every screenshot and hidden from the model's element list. The discovery engine (`src/agent`) runs the observe, decide, act loop with Claude, gates every action through the policy, and the recorder turns the chosen elements into multi-strategy targets and parameterised steps with pre-conditions and post-conditions, so the transcript is evidence but never an input to replay. After a successful run a probe phase replays the new artifact with deliberately bad inputs and asks the model, once and in a bounded way, to classify the state it stopped in, which is how the artifact learns conditions such as MEMBER_NOT_FOUND, and a verification replay then proves the fresh artifact replays model-free before it counts as recorded.

The replay engine (`src/replay`) is an interpreter over the artifact, it checks the step's pre-conditions, resolves each target through an ordered cascade of locator strategies (role and name, label, visible text, table relation, attributes, css, xpath, visual template match), checks the policy, acts, waits for the frames to settle, answers only the dialog the step recorded, verifies the post-conditions, and runs the condition detectors before every step and after every failure so that business outcomes, recoverable conditions and hard failures are told apart in the result contract. Irreversible steps are protected three ways, a per-run cap, a four-eyes rule (the invocation's approver must differ from its requester) and an idempotency ledger that returns the earlier result instead of posting twice and escalates when an earlier attempt never recorded an outcome. When a control cannot be found, an optional assisted recovery asks the model once which visible element matches the step's intent, runs it through the same policy gate, and records the proposal for a reviewer.

The human-in-the-loop layer (`src/hitl`) holds a control token for the live session, raises intervention requests with the full context, streams the live browser to an operator console over the Chrome DevTools Protocol, forwards the operator's mouse and keyboard into that same session while the automation is paused, records every human action as a replayable target, resumes when the operator hands control back, and turns what the human did into a proposed condition the artifact can learn. Every control-plane event (interventions, control transfers, human actions, approvals, ledger commits) lands in a hash-chained audit log. The catalog (`src/catalog`) stores artifacts with a content hash that approvals are bound to (an edited artifact silently drops back to draft), exports them as function-calling tool definitions, serves them over HTTP so an AI agent can invoke a capability by name with typed arguments, generates a standalone Playwright script from an artifact, and diffs versions for reviewers.

## Setup

You need Node 20 or newer and npm. Install the dependencies and the Chromium build that Playwright drives, create your local environment file, and let the doctor check the setup.

```bash
npm install
npx playwright install chromium
cp .env.example .env
./bin/cua.js doctor
```

Put your `ANTHROPIC_API_KEY` in `.env` for the discovery run (replay does not need it). The mock app's credentials in `.env.example` are fake and are the app's own defaults, they only exist so the automation resolves them through the tenant secret bindings the same way it would resolve a vault reference in production, and they never get written to an artifact or a log.

## The demo path

Start the mock teller console in one terminal, it listens on http://localhost:4173 and serves two tenants, `summit` at `/t/summit/` and `cascade` at `/t/cascade/` (same vendor product, different branding, field names, labels and column order).

```bash
npm run app
```

In a second terminal, run the LLM discovery of a goal. The probe flag replays the recorded flow with a member that does not exist and learns the resulting business outcome, the verification replay runs automatically, and the operator console starts on http://127.0.0.1:4790 in case the run needs a human.

```bash
./bin/cua.js discover \
  --goal "Look up member 10023 and read their current savings balance" \
  --input member_id=10023 --sensitive member_id \
  --probe not_found:member_id=99999
```

Replay the resulting artifact with new inputs, first the happy path, then a member that does not exist, then a restricted member, then a replay with an injected session expiry (the `--chaos` flag arms a fault on the mock app, it is a test hook and the policy denies the agent access to it), and then a replay restricted to visual template matching plus text (the stand-in for OCR), which is how a screenshot-driven desktop surface would run it, since a parameterised link can never be found from a recorded crop.

```bash
./bin/cua.js replay member.lookup_savings_balance --input member_id=10024
./bin/cua.js replay member.lookup_savings_balance --input member_id=99999
./bin/cua.js replay member.lookup_savings_balance --input member_id=55555
./bin/cua.js replay member.lookup_savings_balance --input member_id=10024 --chaos session_expired:1:/inquiry
./bin/cua.js replay member.lookup_savings_balance --input member_id=10023 --locators visual,text
```

To see the handoff, arm an interstitial the app profile does not know about and open the console in your browser when the run pauses, take control, click the acknowledge button in the live view, and hand back with retry. If you would rather not click yourself, the scripted operator does exactly the same thing through the console's HTTP and WebSocket API. Afterwards, promote what the operator did into a condition, and the same fault replays with no human.

```bash
./bin/cua.js replay member.lookup_savings_balance --input member_id=10087 --chaos security_bulletin:1:/inquiry --label handoff
# in a third terminal, or just open http://127.0.0.1:4790 and do it by hand
npx tsx scripts/operator-bot.ts --click "I Acknowledge" --resolve retry
./bin/cua.js promote member.lookup_savings_balance --run runs/handoff --conditions
./bin/cua.js replay member.lookup_savings_balance --input member_id=10087 --chaos security_bulletin:1:/inquiry
```

The second capability is irreversible (it posts a new share), so discovery pauses for an operator's approval before the Confirm click, and unattended replay needs an approved artifact, an invocation approval from someone other than the requester, and ideally an idempotency key, so a retried call returns the earlier confirmation instead of posting twice.

```bash
./bin/cua.js discover \
  --goal "Open a new Club Savings sub-account (share) for member 10023 with a 25.00 initial deposit and reach the confirmation screen" \
  --input member_id=10023 --input "share_type=Club Savings" --input "description=Vacation fund" --input initial_deposit=25.00 \
  --sensitive member_id --probe low_deposit:initial_deposit=1.00
./bin/cua.js approve member.open_share --by "your name"
./bin/cua.js replay member.open_share --input member_id=10024 --input "share_type=Money Market" --input "description=Rainy day" --input initial_deposit=40.00 \
  --approve "ticket CU-4411" --approved-by supervisor.jane --requested-by agent:servicing --idempotency-key CU-4411
./bin/cua.js replay member.open_share --input member_id=10024 --input "share_type=Money Market" --input "description=Rainy day" --input initial_deposit=40.00 \
  --approve "ticket CU-4411" --approved-by supervisor.jane --requested-by agent:servicing --idempotency-key CU-4411   # → DUPLICATE_INVOCATION
```

The whole sequence, including the cross-tenant replay on `cascade`, the promotion of its fallback resolutions into tenant overrides, an assisted recovery, the learned condition, the vision-only replay and a run of the generated Playwright script, is scripted in `scripts/demo.ts`, and it writes the curated evidence folder with an index and an HTML report per run.

```bash
npm run demo:all              # LLM discovery, needs ANTHROPIC_API_KEY
npm run demo:all -- --scripted   # same pipeline without a model (see below)
```

## Running without model access

The decision step of the discovery loop is a small interface, and next to the Claude implementation there is a scripted one that chooses the same kind of actions from the observation, so the loop, the policy gate, the recorder, the probe, the verification replay and the evidence path all run without a model. It exists for the test-suite and for anyone who wants to try the pipeline without a key, and every artifact it produces says so in its provenance (`recordedBy.kind` is `scripted`, an LLM run says `llm` with the model id). Use `--decider scripted:lookup_savings_balance` or `--decider scripted:open_new_share` on the discover command, `--assist scripted:<flow>` on replay, or pass `--scripted` to the demo. The brief asks for a genuine LLM-driven run in `/evidence/`, so the committed evidence must come from the default LLM path.

## Command reference

| Command | What it does |
|---|---|
| `./bin/cua.js discover --goal ... --input k=v [--sensitive k] [--probe name:k=v] [--name a.b] [--decider llm\|scripted:flow] [--no-verify] [--headed] [--no-console]` | LLM-driven discovery, records a draft artifact into `capabilities/` (with a verification replay), evidence into `runs/` |
| `./bin/cua.js replay <name[@version]\|file> --input k=v [--tenant id] [--approve reason --approved-by who --requested-by who] [--idempotency-key k] [--locators kinds, an allow list that is also the preference order] [--assist decider] [--chaos scenario[:count[:path]]] [--times n] [--no-console]` | Deterministic replay, exit code 0 on success, 2 on a business outcome, 1 on failure |
| `./bin/cua.js list` / `show <name>` / `validate <files>` / `diff <a> <b>` / `schema` | Catalog, reviewer view, schema plus integrity validation, version diff, JSON Schema export |
| `./bin/cua.js approve <name> --by <who>` | Approves an artifact for unattended replay, bound to its content hash |
| `./bin/cua.js promote <name> --run <evidenceDir> [--tenant id] [--conditions]` | Turns a run's fallback resolutions into tenant overrides, or the operator's actions into conditions (new draft version) |
| `./bin/cua.js report <runDirs>` / `codegen <name> --input k=v --out file.ts` | HTML report for a run; standalone Playwright script from an artifact |
| `./bin/cua.js audit verify` / `audit tail` / `doctor` | Verify the hash-chained audit log; check the local setup |
| `./bin/cua.js tools` / `serve [--port 4780]` | The catalog as function-calling tool definitions, and as an HTTP API that agents invoke (`POST /capabilities/:name/invoke` with `inputs`, `requestedBy`, `approval`, `idempotencyKey`) |
| `npm run app` | The mock LegacyCore teller console on port 4173 |
| `npm test`, `npm run typecheck`, `npm run lint` | Unit tests plus the two end-to-end suites against the mock app |

`examples/agent-invokes-capability.ts` shows an AI agent discovering the catalog as tools and invoking a capability through `cua serve` with an idempotency key to answer a question.

## The operator console

Every discover and replay run starts the console on port 4790 (a busy port falls back to a random one and the URL is printed, and a bearer token from `CUA_CONSOLE_TOKEN` or `policy.yaml` can be required). It lists open interventions with the capability, goal, step, why the run stopped, what was expected and observed, the screenshot at that moment and the interactive elements on screen. An approval request is resolved with approve or deny. A stuck or failed run is resolved by taking control, which streams the live session into the page and forwards your clicks and keystrokes into it, and then handing back with retry (run the failed step again), skip, resume (continue with the next step) or abort. Everything you do while in control is recorded in the run's evidence with a replayable description of the element you touched, the automation cannot act while you hold control, and if the run then succeeds, your clicks are offered back as a proposed condition. Each intervention can also be posted to a webhook (`escalation.webhookUrl`) for paging.

## Repository layout

`src/core` holds the artifact schema, the result contract, the event vocabulary and template helpers, `src/surface` the Playwright surface and the injected indexer, `src/agent` the discovery loop, the Claude and scripted deciders, the recorder and the probe, `src/replay` the step executor, condition detection, session bootstrap, the idempotency ledger and the replay engine, `src/hitl` the intervention broker, the live-session controller, the console and the audit log, `src/policy` the policy gate, redaction and the secret store, `src/evidence` the run evidence store and the HTML report, `src/catalog` the artifact store, integrity, tool mapping, codegen, diff and the HTTP API, and `src/cli` the commands. `apps/legacycore` is the mock app, `profiles/` and `tenants/` are the app profile and tenant bindings, `policy.yaml` is the safety policy, `capabilities/` is the artifact catalog, `evidence/` is the curated evidence, `runs/` and `state/` are where ad hoc runs and the durable control-plane state land (ignored by git), `docs/` has the exported JSON Schema and the result codes, `tests/` has the unit and end-to-end tests, and `scripts/` has the demo and the scripted operator.

## What a run leaves behind

Each run directory contains `report.html` (open it in a browser), `events.jsonl` (the structured, already redacted log of every observation, decision, policy verdict, resolution, expectation, condition, intervention, human action, assist and ledger entry), `result.json` (the result contract), and `steps/` with one screenshot per step. Discovery runs add `transcript.json` (the model conversation with screenshots replaced by file references), `artifact.json` and `trace.zip`. Failed runs add `failure/` with a screenshot, a DOM snapshot of every frame and a Playwright trace you can open with `npx playwright show-trace`. Interventions are written under `interventions/` with the human's actions and screenshots, and the demo also snapshots `state/audit.jsonl` and `state/ledger.jsonl` into the evidence folder.

## Configuration

`policy.yaml` is the allowlist of origins, paths and action kinds, the deny list (the chaos and reset hooks and the sign-off route are denied), the control-name patterns that classify an action as mutating or irreversible, the four-eyes switch, the modes for discovery (confirm) and replay (approved_only), the escalation timeout, console port and token, the optional webhook, the assisted-recovery switch and cap, the screenshot masking mode, and the run limits including the irreversible-actions cap. `profiles/legacycore-teller.json` describes the app family once, with the login flow (credentials are secret references), the marker that proves an authenticated session, the content frame, the conditions every capability on that app shares, the data policy (labels and field names to mask) and the locator policy (which strategies this surface can execute). `tenants/*.json` bind a tenant to a profile with its base URL, template parameters and secret bindings of the form `env:VAR` (a vault URI would go in the same place). The mock app reads `LEGACYCORE_USER`, `LEGACYCORE_PASSWORD`, `LEGACYCORE_CASCADE_PASSWORD` and `PORT`, and exposes `POST /__chaos`, `POST /__chaos/reset` and `POST /__reset` as test hooks.

## Tests and CI

`npm test` runs the unit tests (schema, templates, policy including four-eyes, redaction, parsers, integrity, ledger, audit chain, promotion) and two end-to-end suites, which start the mock app if it is not already running and drive the real pipeline with the scripted decider through discovery, verification, replay, business outcomes, every injected fault, the live-session handoff, the approval gate, duplicate invocations, assisted recovery, learned conditions, masking, the vision-only replay, the HTML report and the generated script, so the whole suite takes about six minutes. The GitHub Actions workflow runs typecheck, lint, format check and the tests on every push.

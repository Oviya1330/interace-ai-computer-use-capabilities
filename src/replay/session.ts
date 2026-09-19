/**
 * Session bootstrap: runs the app profile's login flow so capabilities never need to record
 * credentials handling themselves. Also used by the `reauthenticate` condition handler.
 */
import type { AppProfile, TenantBinding } from "../core/schema.js";
import { resolveValue, type Params, type SecretResolver } from "../core/template.js";
import { RunFailure } from "../core/errors.js";
import type { Surface } from "../surface/types.js";
import type { EventSink } from "../core/events.js";
import type { PolicyGate, PolicyContext } from "../policy/policy.js";
import { executeStep } from "./steps.js";
import { detectCondition } from "./conditions.js";

export interface SessionContext {
  surface: Surface;
  profile: AppProfile;
  tenant: TenantBinding;
  params: Params;
  secrets: SecretResolver;
  policy: PolicyGate;
  policyCtx: PolicyContext;
  events: EventSink;
}

export async function ensureAuthenticated(ctx: SessionContext): Promise<"already" | "logged_in"> {
  const { surface, profile, params, events } = ctx;
  const entry = resolveValue(profile.session.login.entry, params, ctx.secrets).value;
  if (!surface.currentUrl().startsWith(ctx.tenant.baseUrl)) {
    await surface.navigate(entry);
    await surface.settle();
  }
  const auth = await surface.check(profile.session.login.authenticated, params, {
    timeoutMs: 1500,
  });
  if (auth.ok) {
    events.emit("session.bootstrap", "Session already authenticated", { tenant: ctx.tenant.id });
    return "already";
  }
  events.emit(
    "session.bootstrap",
    `Signing on to ${ctx.tenant.displayName} via profile ${profile.id}`,
    {
      tenant: ctx.tenant.id,
      entry,
    },
  );
  await surface.navigate(entry);
  await surface.settle();
  for (const step of profile.session.login.steps) {
    await executeStep(step, {
      surface,
      policy: ctx.policy,
      policyCtx: ctx.policyCtx,
      params,
      secrets: ctx.secrets,
      events,
      defaultTimeoutMs: profile.defaultStepTimeoutMs,
      label: `session:${step.id}`,
    });
  }
  let after = await surface.check(profile.session.login.authenticated, params, { timeoutMs: 3000 });
  // Post-login interstitials (notices) are profile conditions with a dismiss handler.
  for (let i = 0; i < 2 && !after.ok; i++) {
    const hit = await detectCondition(profile.conditions, surface, params);
    if (!hit || hit.condition.class !== "recoverable" || hit.condition.handler?.kind !== "dismiss")
      break;
    events.emit(
      "condition.detected",
      `Condition "${hit.condition.id}" after sign-on; dismissing via ${hit.condition.handler.target.description}`,
      { conditionId: hit.condition.id, phase: "session" },
    );
    const r = await surface.resolve(hit.condition.handler.target, params, { timeoutMs: 5000 });
    await surface.click(r);
    await surface.settle();
    after = await surface.check(profile.session.login.authenticated, params, {
      timeoutMs: profile.defaultStepTimeoutMs,
    });
  }
  if (!after.ok) {
    throw new RunFailure("SESSION_LOST", "Sign-on did not produce an authenticated session", {
      expected: "authenticated marker visible",
      observed: after.observed,
    });
  }
  events.emit("session.bootstrap", "Session authenticated", { tenant: ctx.tenant.id });
  return "logged_in";
}

import type { SecretResolver } from "../core/template.js";
import type { Redactor } from "./redact.js";

export class SecretUnavailableError extends Error {
  constructor(ref: string, source: string) {
    super(`Secret "${ref}" is not available (${source})`);
    this.name = "SecretUnavailableError";
  }
}

/**
 * Resolves `secret` ValueRefs. Bindings map a logical ref ("teller_password") to a source
 * ("env:LEGACYCORE_PASSWORD"). Production would point at a vault; the seam is this interface.
 * Every resolved value is registered with the redactor so it can never reach a sink.
 */
export class EnvSecretStore implements SecretResolver {
  constructor(
    private readonly bindings: Record<string, string>,
    private readonly redactor: Redactor,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  has(ref: string): boolean {
    return ref in this.bindings;
  }

  resolve(ref: string): string {
    const source = this.bindings[ref];
    if (!source) throw new SecretUnavailableError(ref, "no binding");
    if (source.startsWith("env:")) {
      const value = this.env[source.slice(4)];
      if (!value) throw new SecretUnavailableError(ref, `${source} is unset`);
      this.redactor.registerSecret(value);
      return value;
    }
    if (source.startsWith("literal:")) {
      // Only for tests; never use in a real tenant binding.
      const value = source.slice(8);
      this.redactor.registerSecret(value);
      return value;
    }
    throw new SecretUnavailableError(ref, `unsupported source ${source.split(":")[0]}`);
  }

  refs(): string[] {
    return Object.keys(this.bindings);
  }
}

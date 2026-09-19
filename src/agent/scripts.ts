/**
 * Scripted discovery flows for the mock LegacyCore app. They run the real discovery loop
 * (policy gate, recorder, evidence) without a model, so the offline test-suite and the
 * `--decider scripted:<name>` demo path exercise the same code as an LLM run.
 */
import { ScriptedDecider, find, type ScriptStep } from "./scripted.js";
import type { ContractProposal } from "./decider.js";

const need = (label: string, ref: string | undefined): string => {
  if (!ref) throw new Error(`scripted flow: could not find ${label} on the current screen`);
  return ref;
};

function reachMemberProfile(inputs: Record<string, string>): ScriptStep[] {
  return [
    (obs) => [
      {
        tool: "click",
        ref: need(
          "inquiry nav link",
          find.byRoleName("link", /^Member (Inquiry|Lookup)$/, "nav")(obs)?.ref,
        ),
        why: "Open the member inquiry function from the menu",
        accept_dialog: false,
      },
    ],
    (obs) => [
      {
        tool: "type",
        ref: need(
          "member number box",
          obs.elements.find((e) => e.interactive && /^Member (Number|#)$/.test(e.labelText ?? ""))
            ?.ref,
        ),
        text: inputs.member_id!,
        why: "Enter the member number to search for",
        press_enter: false,
      },
      {
        tool: "click",
        ref: need("search button", find.byRoleName("button", /^(Search|Find)$/)(obs)?.ref),
        why: "Run the search",
        accept_dialog: false,
      },
    ],
    (obs) => [
      {
        tool: "click",
        ref: need(
          "member result link",
          find.byRoleName("link", inputs.member_id!, "main")(obs)?.ref,
        ),
        why: "Open the matching member's profile",
        accept_dialog: false,
      },
    ],
  ];
}

export function lookupSavingsBalance(inputs: Record<string, string>): ScriptedDecider {
  const script: ScriptStep[] = [
    ...reachMemberProfile(inputs),
    (obs) => [
      {
        tool: "extract",
        ref: need("savings balance cell", find.cell("Balance", "Savings")(obs)?.ref),
        output: "savings_balance",
        parse: "currency",
        why: "Read the current balance of the Savings share",
      },
    ],
    (obs) => [
      {
        tool: "done",
        summary: "Located the member and read the Savings share balance.",
        evidence_ref: need("Accounts heading", find.text("Accounts")(obs)?.ref),
      },
    ],
  ];
  const contract: ContractProposal = {
    name: "member.lookup_savings_balance",
    title: "Look up a member's savings balance",
    description:
      "Searches the teller console for a member by member number, opens the profile and returns the current balance of the Savings share.",
    inputs: [
      {
        name: "member_id",
        type: "string",
        description: "Five-digit member number",
        sensitivity: "pii",
        pattern: "^\\d{5}$",
      },
    ],
    outputs: [
      {
        name: "savings_balance",
        type: "number",
        description: "Current balance of the member's Savings share in USD",
        sensitivity: "financial",
      },
    ],
    checkpointDescription:
      "The member profile with the Accounts table is displayed for the requested member.",
    sideEffects: "none",
  };
  return new ScriptedDecider(
    script,
    () => contract,
    () => ({
      class: "business_outcome",
      code: "MEMBER_NOT_FOUND",
      description: "The inquiry returned no member for the supplied member number.",
      message: "No member exists with the supplied member number.",
      detectorText: "No member found matching",
      dismissRef: null,
    }),
  );
}

export function openNewShare(inputs: Record<string, string>): ScriptedDecider {
  const script: ScriptStep[] = [
    ...reachMemberProfile(inputs),
    (obs) => [
      {
        tool: "click",
        ref: need("New Share button", find.byRoleName("button", "New Share")(obs)?.ref),
        why: "Start the new share (sub-account) form",
        accept_dialog: false,
      },
    ],
    (obs) => [
      {
        tool: "select",
        ref: need("share type", find.byLabel("Share Type")(obs)?.ref),
        value: inputs.share_type!,
        why: "Choose the share type",
      },
      {
        tool: "type",
        ref: need("description", find.byLabel("Description")(obs)?.ref),
        text: inputs.description!,
        why: "Describe the new share",
        press_enter: false,
      },
      {
        tool: "type",
        ref: need("initial deposit", find.byLabel("Initial Deposit")(obs)?.ref),
        text: inputs.initial_deposit!,
        why: "Fund the share with the initial deposit",
        press_enter: false,
      },
      {
        tool: "click",
        ref: need("Review button", find.byRoleName("button", "Review")(obs)?.ref),
        why: "Review the new share before posting",
        accept_dialog: false,
      },
    ],
    (obs) => [
      {
        tool: "click",
        ref: need("Confirm/Post button", find.byRoleName("button", /^(Confirm|Post)$/)(obs)?.ref),
        why: "Post the new share after review",
        accept_dialog: true,
      },
    ],
    (obs) => [
      {
        tool: "extract",
        ref: need(
          "confirmation number",
          obs.elements.find((e) => e.labelText === "Confirmation Number")?.ref,
        ),
        output: "confirmation_number",
        parse: "text",
        why: "Capture the confirmation number for the caller",
      },
    ],
    (obs) => [
      {
        tool: "done",
        summary: "Opened the new share and captured the confirmation number.",
        evidence_ref: need("Share Opened heading", find.text("Share Opened")(obs)?.ref),
      },
    ],
  ];
  const contract: ContractProposal = {
    name: "member.open_share",
    title: "Open a new share (sub-account) for a member",
    description:
      "Finds the member, fills the New Share form (type, description, initial deposit), reviews it and posts it, returning the confirmation number.",
    inputs: [
      {
        name: "member_id",
        type: "string",
        description: "Five-digit member number",
        sensitivity: "pii",
        pattern: "^\\d{5}$",
      },
      {
        name: "share_type",
        type: "string",
        description: "Share product to open (Savings, Club Savings, Money Market)",
        sensitivity: "none",
        pattern: null,
      },
      {
        name: "description",
        type: "string",
        description: "Free-text description for the new share",
        sensitivity: "none",
        pattern: null,
      },
      {
        name: "initial_deposit",
        type: "number",
        description: "Initial deposit in USD (minimum 5.00), moved from the member's funding share",
        sensitivity: "financial",
        pattern: null,
      },
    ],
    outputs: [
      {
        name: "confirmation_number",
        type: "string",
        description: "Confirmation number of the posted share",
        sensitivity: "none",
      },
    ],
    checkpointDescription:
      "The Share Opened confirmation screen is displayed with a confirmation number.",
    sideEffects: "creates_record",
  };
  return new ScriptedDecider(
    script,
    () => contract,
    () => ({
      class: "business_outcome",
      code: "VALIDATION_ERROR",
      description: "The New Share form rejected the supplied values.",
      message: "The application rejected the new share request; see the validation message.",
      detectorText: "Initial deposit must be at least",
      dismissRef: null,
    }),
  );
}

export const SCRIPTED_FLOWS: Record<string, (inputs: Record<string, string>) => ScriptedDecider> = {
  lookup_savings_balance: lookupSavingsBalance,
  open_new_share: openNewShare,
};

/** Tool definitions exposed to the model. Strict schemas: inputs validate exactly. */
import type Anthropic from "@anthropic-ai/sdk";

const ref = {
  type: "string",
  description: 'Element ref from the observation, e.g. "e12"',
} as const;
const why = {
  type: "string",
  description: "One sentence: why this action moves toward the goal",
} as const;

export const AGENT_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "click",
    description: "Click an interactive element (link, button, checkbox, row link).",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        ref,
        why,
        accept_dialog: {
          type: "boolean",
          description:
            "Set true ONLY when repeating a click whose confirm() dialog was dismissed and accepting it is required for the goal.",
        },
      },
      required: ["ref", "why", "accept_dialog"],
      additionalProperties: false,
    },
  },
  {
    name: "type",
    description:
      "Replace the content of a text box with the given text. Use the exact parameter values you were given.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        ref,
        text: { type: "string" },
        why,
        press_enter: {
          type: "boolean",
          description: "Press Enter after typing (submits the form).",
        },
      },
      required: ["ref", "text", "why", "press_enter"],
      additionalProperties: false,
    },
  },
  {
    name: "type_secret",
    description:
      "Type a secret (e.g. a password) that you are NOT shown, referenced by its secret name. Never type secrets with `type`.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        ref,
        secret: { type: "string", description: "Secret name from the task, e.g. teller_password" },
        why,
      },
      required: ["ref", "secret", "why"],
      additionalProperties: false,
    },
  },
  {
    name: "select",
    description: "Choose an option in a drop-down (combobox) by its visible label.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { ref, value: { type: "string", description: "Visible option label" }, why },
      required: ["ref", "value", "why"],
      additionalProperties: false,
    },
  },
  {
    name: "press",
    description: "Press a keyboard key (Enter, Tab, Escape).",
    strict: true,
    input_schema: {
      type: "object",
      properties: { key: { type: "string", enum: ["Enter", "Tab", "Escape"] }, why },
      required: ["key", "why"],
      additionalProperties: false,
    },
  },
  {
    name: "navigate",
    description: "Load a URL directly. Prefer clicking links; use only when no link is available.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { url: { type: "string" }, why },
      required: ["url", "why"],
      additionalProperties: false,
    },
  },
  {
    name: "extract",
    description:
      "Read a value from the screen and record it as a named output of the capability (e.g. savings_balance). Choose the element that contains ONLY the value (a table cell, not the whole row).",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        ref,
        output: { type: "string", description: "snake_case output name" },
        parse: {
          type: "string",
          enum: ["text", "number", "currency"],
          description: "How to parse the value",
        },
        why,
      },
      required: ["ref", "output", "parse", "why"],
      additionalProperties: false,
    },
  },
  {
    name: "wait",
    description: "Wait for a slow screen to finish loading (max 10 seconds).",
    strict: true,
    input_schema: {
      type: "object",
      properties: { seconds: { type: "integer", minimum: 1, maximum: 10 }, why },
      required: ["seconds", "why"],
      additionalProperties: false,
    },
  },
  {
    name: "done",
    description:
      "Declare the goal accomplished. evidence_ref must be an element whose visible text proves the goal state (e.g. the confirmation heading). Call this only after every required output has been extracted.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "What was accomplished, in one or two sentences" },
        evidence_ref: ref,
      },
      required: ["summary", "evidence_ref"],
      additionalProperties: false,
    },
  },
  {
    name: "request_human",
    description:
      "Ask a human operator to take over the live session when you are stuck or the next step needs a person to decide. Describe precisely what you need.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    name: "give_up",
    description:
      "Stop: the goal cannot be reached. Use kind=business_outcome when the application answered with a legitimate result that prevents the goal (record not found, validation error, access denied), impossible when the UI offers no path, unsafe when continuing would violate policy.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string" },
        kind: { type: "string", enum: ["business_outcome", "impossible", "unsafe"] },
      },
      required: ["reason", "kind"],
      additionalProperties: false,
    },
  },
];

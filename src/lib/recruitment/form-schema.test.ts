import { describe, expect, it } from "vitest";

import {
  evaluateVisible,
  formStructureSchema,
  validateSubmission,
  answerToColumns,
  type Field,
  type FormStructure,
} from "./form-schema";

const field = (o: Partial<Field> & Pick<Field, "id" | "type" | "label">): Field =>
  ({ ...o }) as Field;

const structure = (fields: Field[]): FormStructure =>
  formStructureSchema.parse({
    pages: [{ id: "p1", title: "Page 1", fields }],
  });

describe("formStructureSchema", () => {
  it("applies layout/antiSpam/settings defaults", () => {
    const s = structure([field({ id: "a", type: "SHORT_TEXT", label: "Name" })]);
    expect(s.layout.mode).toBe("paged");
    expect(s.antiSpam.honeypot).toBe(true);
    expect(s.version).toBe(1);
  });

  it("rejects unknown keys (strict)", () => {
    expect(
      formStructureSchema.safeParse({ pages: [], bogus: 1 }).success,
    ).toBe(false);
  });
});

describe("validateSubmission", () => {
  it("flags a missing required field, passes when present", () => {
    const s = structure([
      field({ id: "name", type: "SHORT_TEXT", label: "Name", required: true }),
    ]);
    expect(validateSubmission(s, {})).toEqual({
      ok: false,
      errors: { name: "This field is required." },
    });
    expect(validateSubmission(s, { name: "Thrall" })).toEqual({
      ok: true,
      answers: { name: "Thrall" },
    });
  });

  it("does NOT block submission on a hidden required field", () => {
    const s = structure([
      field({ id: "role", type: "SHORT_TEXT", label: "Role" }),
      field({
        id: "healSpec",
        type: "SHORT_TEXT",
        label: "Healing spec",
        required: true,
        visibleWhen: { fieldId: "role", operator: "equals", value: "Healer" },
      }),
    ]);
    // role != Healer → healSpec hidden → its required-ness is ignored
    expect(validateSubmission(s, { role: "Tank" }).ok).toBe(true);
    // role == Healer → healSpec now required
    expect(validateSubmission(s, { role: "Healer" }).ok).toBe(false);
  });

  it("validates email, url, number bounds, and regex patterns", () => {
    const s = structure([
      field({ id: "e", type: "EMAIL", label: "Email", required: true }),
      field({ id: "u", type: "URL", label: "Logs", required: true }),
      field({
        id: "ilvl",
        type: "NUMBER",
        label: "iLvl",
        required: true,
        validation: { min: 1, max: 1000, integerOnly: true },
      }),
      field({
        id: "bt",
        type: "SHORT_TEXT",
        label: "BattleTag",
        required: true,
        validation: { pattern: "^.{2,12}#\\d{4,5}$", patternMessage: "bad tag" },
      }),
    ]);
    const bad = validateSubmission(s, {
      e: "nope",
      u: "not a url",
      ilvl: 5000,
      bt: "x",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(Object.keys(bad.errors).sort()).toEqual(["bt", "e", "ilvl", "u"]);
      expect(bad.errors.bt).toBe("bad tag");
    }
    const good = validateSubmission(s, {
      e: "a@b.com",
      u: "https://warcraftlogs.com/reports/abc",
      ilvl: 489,
      bt: "Thrall#1234",
    });
    expect(good.ok).toBe(true);
  });

  it("enforces single-select option membership and multi-select counts", () => {
    const s = structure([
      field({
        id: "cls",
        type: "SINGLE_SELECT",
        label: "Class",
        required: true,
        options: [
          { id: "1", label: "Warrior", value: "warrior" },
          { id: "2", label: "Mage", value: "mage" },
        ],
      }),
      field({
        id: "days",
        type: "MULTI_SELECT",
        label: "Days",
        required: true,
        validation: { minSelections: 2 },
        options: [
          { id: "1", label: "Tue", value: "tue" },
          { id: "2", label: "Wed", value: "wed" },
          { id: "3", label: "Thu", value: "thu" },
        ],
      }),
    ]);
    expect(validateSubmission(s, { cls: "rogue", days: ["tue", "wed"] }).ok).toBe(
      false,
    ); // rogue not an option
    expect(validateSubmission(s, { cls: "mage", days: ["tue"] }).ok).toBe(false); // < 2 days
    expect(validateSubmission(s, { cls: "mage", days: ["tue", "wed"] }).ok).toBe(
      true,
    );
  });

  it("ignores content blocks (no answer required)", () => {
    const s = structure([
      field({ id: "h", type: "HEADING", label: "About you", content: "hi" }),
      field({ id: "name", type: "SHORT_TEXT", label: "Name", required: true }),
    ]);
    expect(validateSubmission(s, { name: "x" }).ok).toBe(true);
  });
});

describe("evaluateVisible", () => {
  const base = field({ id: "x", type: "SHORT_TEXT", label: "X" });
  it("handles each operator", () => {
    expect(
      evaluateVisible(
        { ...base, visibleWhen: { fieldId: "r", operator: "isFilled" } },
        { r: "a" },
      ),
    ).toBe(true);
    expect(
      evaluateVisible(
        { ...base, visibleWhen: { fieldId: "r", operator: "isEmpty" } },
        { r: "" },
      ),
    ).toBe(true);
    expect(
      evaluateVisible(
        { ...base, visibleWhen: { fieldId: "r", operator: "contains", value: "b" } },
        { r: ["a", "b"] },
      ),
    ).toBe(true);
  });
});

describe("answerToColumns", () => {
  it("routes values to the right storage column", () => {
    expect(answerToColumns("NUMBER", 489)).toMatchObject({ valueNumber: 489 });
    expect(answerToColumns("MULTI_SELECT", ["a", "b"])).toMatchObject({
      valueText: "a, b",
      valueJson: ["a", "b"],
    });
    expect(answerToColumns("YES_NO", true)).toMatchObject({ valueText: "Yes" });
    expect(answerToColumns("SHORT_TEXT", "hi")).toMatchObject({ valueText: "hi" });
  });
});

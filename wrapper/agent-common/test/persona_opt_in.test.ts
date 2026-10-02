import { expect, it } from "vitest";
import { flagArgument, personaOptInSource } from "../src/persona_opt_in.js";

it.each([
  { name: "global flag", flag: "1", personas: undefined, source: "flag" },
  { name: "global flag over an invalid list", flag: "1", personas: "ao,*", source: "flag" },
  { name: "global flag over a list without the id", flag: "1", personas: "other", source: "flag" },
  { name: "flag 0", flag: "0", personas: undefined, source: "off" },
  { name: "flag true", flag: "true", personas: undefined, source: "off" },
  { name: "empty flag", flag: "", personas: undefined, source: "off" },
  { name: "flag with a space", flag: " 1", personas: undefined, source: "off" },
  { name: "no flag, no list", flag: undefined, personas: undefined, source: "off" },
  { name: "non-enabling flag defers to the list", flag: "true", personas: "ao", source: "persona_list" },
  { name: "exact id", flag: undefined, personas: "ao", source: "persona_list" },
  { name: "id among others, trimmed", flag: undefined, personas: "other, ao ,third", source: "persona_list" },
  { name: "tab and newline trimmed", flag: undefined, personas: "\tao\n", source: "persona_list" },
  { name: "id charset", flag: undefined, personas: "a.b_c-1", id: "a.b_c-1", source: "persona_list" },
  { name: "list without the id", flag: undefined, personas: "aoi,other", source: "off" },
  { name: "item that is a prefix of the id", flag: undefined, personas: "a", source: "off" },
  { name: "item that is a suffix of the id", flag: undefined, personas: "o", source: "off" },
  { name: "different case", flag: undefined, personas: "Ao", source: "off" },
  { name: "empty list", flag: undefined, personas: "", source: "off" },
  { name: "whitespace-only list", flag: undefined, personas: "  ", source: "off" },
  { name: "empty item", flag: undefined, personas: "ao,,other", source: "off" },
  { name: "trailing comma", flag: undefined, personas: "ao,", source: "off" },
  { name: "leading comma", flag: undefined, personas: ",ao", source: "off" },
  { name: "star glob", flag: undefined, personas: "ao,*", source: "off" },
  { name: "prefix glob", flag: undefined, personas: "ao*", source: "off" },
  { name: "question-mark glob", flag: undefined, personas: "ao,a?", source: "off" },
  { name: "inner space", flag: undefined, personas: "ao,bad id", source: "off" },
  { name: "semicolon separator", flag: undefined, personas: "ao;other", source: "off" },
  { name: "non-ASCII item", flag: undefined, personas: "ao,あお", source: "off" },
] as const)("resolves $name to $source", ({ flag, personas, source, ...rest }) => {
  const id = "id" in rest ? rest.id : "ao";
  expect(personaOptInSource(id, flag, personas)).toBe(source);
});

// The flag argument that combines the variable and the runner.config.json
// value (issue #469); each row is a row of the design's truth table.
it.each([
  { name: "variable unset, config absent, id not listed", variable: undefined, config: undefined, list: undefined, source: "off" },
  { name: "variable empty, config false, id listed", variable: "", config: false, list: "ao", source: "persona_list" },
  { name: "variable unset, config true, id not listed", variable: undefined, config: true, list: undefined, source: "flag" },
  { name: "variable empty, config true, id listed", variable: "", config: true, list: "ao", source: "flag" },
  { name: "variable 1, config false", variable: "1", config: false, list: undefined, source: "flag" },
  { name: "variable 1, config absent", variable: "1", config: undefined, list: undefined, source: "flag" },
  { name: "variable 0 beats config true", variable: "0", config: true, list: undefined, source: "off" },
  { name: "variable true is not 1 and beats config true", variable: "true", config: true, list: undefined, source: "off" },
  { name: "variable 0, config true, id listed defers to the list", variable: "0", config: true, list: "ao", source: "persona_list" },
  { name: "variable 0, config false, id listed", variable: "0", config: false, list: "ao", source: "persona_list" },
] as const)("flagArgument: $name -> $source", ({ variable, config, list, source }) => {
  expect(personaOptInSource("ao", flagArgument(variable, config), list)).toBe(source);
});

it("flagArgument passes a set variable through verbatim and maps only config true to 1", () => {
  expect(flagArgument("0", true)).toBe("0");
  expect(flagArgument(" 1", undefined)).toBe(" 1");
  expect(flagArgument("", true)).toBe("1");
  expect(flagArgument(undefined, true)).toBe("1");
  expect(flagArgument(undefined, false)).toBeUndefined();
  expect(flagArgument(undefined, undefined)).toBeUndefined();
});

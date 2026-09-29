import { expect, it } from "vitest";
import { personaOptInSource } from "../src/persona_opt_in.js";

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

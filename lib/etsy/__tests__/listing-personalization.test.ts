import { describe, expect, test } from "vitest";
import {
  EMPTY_PERSONALIZATION_QUESTION,
  personalizationQuestionsError,
  toPersonalizationWire,
  type PersonalizationQuestionInput,
} from "@/lib/etsy/listing-personalization";

const textQuestion: PersonalizationQuestionInput = {
  ...EMPTY_PERSONALIZATION_QUESTION,
  questionText: "Engraving",
  instructions: "Enter the name",
  required: true,
  fieldType: "text_input",
  maxAllowedCharacters: 50,
};

const dropdownQuestion: PersonalizationQuestionInput = {
  ...EMPTY_PERSONALIZATION_QUESTION,
  questionText: "Font",
  required: true,
  fieldType: "dropdown",
  options: ["Arial", "Times New Roman"],
};

const uploadQuestion: PersonalizationQuestionInput = {
  ...EMPTY_PERSONALIZATION_QUESTION,
  questionText: "Family photo",
  required: false,
  fieldType: "unlabeled_upload",
  maxAllowedFiles: 3,
};

describe("toPersonalizationWire", () => {
  test("maps a text_input question, including instructions", () => {
    expect(toPersonalizationWire(textQuestion)).toEqual({
      question_text: "Engraving",
      question_type: "text_input",
      required: true,
      instructions: "Enter the name",
      max_allowed_characters: 50,
    });
  });

  test("maps a dropdown question's options and drops instructions (Etsy rejects them there)", () => {
    expect(
      toPersonalizationWire({ ...dropdownQuestion, instructions: "should be dropped" }),
    ).toEqual({
      question_text: "Font",
      question_type: "dropdown",
      required: true,
      options: [{ label: "Arial" }, { label: "Times New Roman" }],
    });
  });

  test("maps an unlabeled_upload question's max_allowed_files", () => {
    expect(toPersonalizationWire(uploadQuestion)).toEqual({
      question_text: "Family photo",
      question_type: "unlabeled_upload",
      required: false,
      max_allowed_files: 3,
    });
  });

  test("carries an existing question_id when editing", () => {
    expect(toPersonalizationWire({ ...textQuestion, questionId: 12345 })).toMatchObject({
      question_id: 12345,
    });
  });

  test("trims blank options and empty instructions", () => {
    const wire = toPersonalizationWire({
      ...dropdownQuestion,
      options: ["  Arial  ", "", "  ", "Times New Roman"],
    });
    expect(wire.options).toEqual([{ label: "Arial" }, { label: "Times New Roman" }]);
  });
});

describe("personalizationQuestionsError", () => {
  test("allows an empty list — personalization is optional", () => {
    expect(personalizationQuestionsError([])).toBeNull();
  });

  test("allows a valid mix of text_input, dropdown and one upload question", () => {
    expect(personalizationQuestionsError([textQuestion, dropdownQuestion])).toBeNull();
  });

  test("rejects a blank question label", () => {
    expect(
      personalizationQuestionsError([{ ...textQuestion, questionText: "  " }]),
    ).toMatch(/enter a label/i);
  });

  test("rejects a label over 45 characters", () => {
    expect(
      personalizationQuestionsError([{ ...textQuestion, questionText: "x".repeat(46) }]),
    ).toMatch(/45 characters/);
  });

  test("rejects instructions over 120 characters", () => {
    expect(
      personalizationQuestionsError([{ ...textQuestion, instructions: "x".repeat(121) }]),
    ).toMatch(/120 characters/);
  });

  test("rejects a text_input max character count outside 1-1024", () => {
    expect(
      personalizationQuestionsError([{ ...textQuestion, maxAllowedCharacters: 0 }]),
    ).toMatch(/max character count/i);
    expect(
      personalizationQuestionsError([{ ...textQuestion, maxAllowedCharacters: 1025 }]),
    ).toMatch(/max character count/i);
  });

  test("rejects an upload max file count outside 1-10", () => {
    expect(
      personalizationQuestionsError([{ ...uploadQuestion, maxAllowedFiles: 0 }]),
    ).toMatch(/max files/i);
    expect(
      personalizationQuestionsError([{ ...uploadQuestion, maxAllowedFiles: 11 }]),
    ).toMatch(/max files/i);
  });

  test("rejects a dropdown with no options", () => {
    expect(personalizationQuestionsError([{ ...dropdownQuestion, options: [] }])).toMatch(
      /at least one option/i,
    );
  });

  test("rejects a dropdown option over 20 characters", () => {
    expect(
      personalizationQuestionsError([{ ...dropdownQuestion, options: ["x".repeat(21)] }]),
    ).toMatch(/20 characters/);
  });

  test("rejects duplicate dropdown options (case-insensitive)", () => {
    expect(
      personalizationQuestionsError([{ ...dropdownQuestion, options: ["Arial", "arial"] }]),
    ).toMatch(/unique/i);
  });

  test("rejects more than one file-upload question", () => {
    expect(
      personalizationQuestionsError([uploadQuestion, { ...uploadQuestion, questionText: "Second" }]),
    ).toMatch(/one file-upload/i);
  });

  test("rejects more than 5 questions", () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      ...textQuestion,
      questionText: `Q${i}`,
    }));
    expect(personalizationQuestionsError(six)).toMatch(/at most 5/i);
  });
});

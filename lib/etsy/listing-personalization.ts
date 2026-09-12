/**
 * Etsy's listing personalization model — confirmed via the Etsy MCP server
 * (`get_endpoint`/`get_schema` on `updateListingPersonalization`/
 * `getListingPersonalization`, plus the `tutorials/personalization/examples`
 * and `tutorials/personalization-migration` guides). Not invented.
 *
 * IMPORTANT: Etsy's *older* flat fields — `personalization_is_required`,
 * `personalization_char_count_max`, `personalization_instructions` — are
 * confirmed **deprecated** by Etsy's own migration guide: "Listing
 * create/update requests that include these fields will return an error,
 * and they are no longer returned when reading listing data." Neither
 * `createDraftListing` nor `updateListing` has personalization parameters at
 * all (checked directly against their request-body schemas). The current
 * API is a dedicated resource instead: `POST/GET/DELETE
 * .../listings/{id}/personalization`, holding up to 5 typed
 * `personalization_questions`. `is_personalizable` is read-only, derived by
 * Etsy from whether any questions exist — this app never sets it directly.
 *
 * Etsy documents 4 question types (`text_input`, `dropdown`,
 * `unlabeled_upload`, `labeled_upload`); this app's 3-way field-type picker
 * ("Text box" / "List of options" / "File upload") covers `text_input`,
 * `dropdown`, and `unlabeled_upload`. `labeled_upload` (named upload slots,
 * e.g. "Dad" / "Mom" / "Children" each with their own photo) is a distinct,
 * more specialized field this UI doesn't expose — Etsy does have a File
 * upload equivalent, just not that particular labeled variant.
 *
 * Dependency-free so both server code (`lib/etsy/listing-create.ts`,
 * `app/api/mockups/render/route.ts`) and client UI (`ListingForm.tsx`,
 * `app/mockups/page.tsx`) can import it.
 */

/** Etsy allows at most 5 personalization questions per listing; this UI exposes 2. */
export const PERSONALIZATION_MAX_QUESTIONS = 5;
export const PERSONALIZATION_QUESTION_TEXT_MAX = 45;
export const PERSONALIZATION_INSTRUCTIONS_MAX = 120;
/** `max_allowed_characters` bounds for a text_input question. */
export const PERSONALIZATION_CHAR_COUNT_MIN = 1;
export const PERSONALIZATION_CHAR_COUNT_MAX = 1024;
/** `max_allowed_files` bounds for an upload question. */
export const PERSONALIZATION_MAX_FILES_MIN = 1;
export const PERSONALIZATION_MAX_FILES_MAX = 10;
/** `options` bounds for a dropdown question. */
export const PERSONALIZATION_MIN_OPTIONS = 1;
export const PERSONALIZATION_MAX_OPTIONS = 30;
export const PERSONALIZATION_OPTION_LABEL_MAX = 20;

export const PERSONALIZATION_FIELD_TYPES = [
  { value: "text_input", label: "Text box" },
  { value: "dropdown", label: "List of options" },
  { value: "unlabeled_upload", label: "File upload" },
] as const;
export type PersonalizationFieldType = (typeof PERSONALIZATION_FIELD_TYPES)[number]["value"];

export interface PersonalizationQuestionInput {
  /** Present only when editing a question that already exists on the listing (Etsy assigns it). */
  questionId?: number;
  /** The label/prompt shown to the buyer — Etsy's `question_text`. */
  questionText: string;
  /** Shown to the buyer alongside the field. Etsy ignores/rejects this for `dropdown`. */
  instructions: string;
  required: boolean;
  fieldType: PersonalizationFieldType;
  /** `text_input` only. */
  maxAllowedCharacters: number;
  /** `unlabeled_upload` only. */
  maxAllowedFiles: number;
  /** `dropdown` only. */
  options: string[];
}

export const EMPTY_PERSONALIZATION_QUESTION: PersonalizationQuestionInput = {
  questionText: "",
  instructions: "",
  required: false,
  fieldType: "text_input",
  maxAllowedCharacters: 50,
  maxAllowedFiles: 1,
  options: [],
};

/** Validates one question against Etsy's documented field-level constraints. Returns a user-facing error, or null. */
export function personalizationQuestionError(
  q: PersonalizationQuestionInput,
  label: string,
): string | null {
  const text = q.questionText.trim();
  if (!text) return `${label}: enter a label/prompt shown to the buyer.`;
  if (text.length > PERSONALIZATION_QUESTION_TEXT_MAX) {
    return `${label}: the label must be ${PERSONALIZATION_QUESTION_TEXT_MAX} characters or fewer.`;
  }
  if (q.fieldType !== "dropdown" && q.instructions.trim().length > PERSONALIZATION_INSTRUCTIONS_MAX) {
    return `${label}: instructions must be ${PERSONALIZATION_INSTRUCTIONS_MAX} characters or fewer.`;
  }
  if (q.fieldType === "text_input") {
    if (
      !Number.isInteger(q.maxAllowedCharacters) ||
      q.maxAllowedCharacters < PERSONALIZATION_CHAR_COUNT_MIN ||
      q.maxAllowedCharacters > PERSONALIZATION_CHAR_COUNT_MAX
    ) {
      return `${label}: max character count must be between ${PERSONALIZATION_CHAR_COUNT_MIN} and ${PERSONALIZATION_CHAR_COUNT_MAX}.`;
    }
  }
  if (q.fieldType === "unlabeled_upload") {
    if (
      !Number.isInteger(q.maxAllowedFiles) ||
      q.maxAllowedFiles < PERSONALIZATION_MAX_FILES_MIN ||
      q.maxAllowedFiles > PERSONALIZATION_MAX_FILES_MAX
    ) {
      return `${label}: max files must be between ${PERSONALIZATION_MAX_FILES_MIN} and ${PERSONALIZATION_MAX_FILES_MAX}.`;
    }
  }
  if (q.fieldType === "dropdown") {
    const options = q.options.map((o) => o.trim()).filter(Boolean);
    if (options.length < PERSONALIZATION_MIN_OPTIONS) return `${label}: add at least one option.`;
    if (options.length > PERSONALIZATION_MAX_OPTIONS) {
      return `${label}: at most ${PERSONALIZATION_MAX_OPTIONS} options are allowed.`;
    }
    const tooLong = options.find((o) => o.length > PERSONALIZATION_OPTION_LABEL_MAX);
    if (tooLong) {
      return `${label}: each option must be ${PERSONALIZATION_OPTION_LABEL_MAX} characters or fewer.`;
    }
    const lower = options.map((o) => o.toLowerCase());
    if (new Set(lower).size !== lower.length) return `${label}: options must be unique.`;
  }
  return null;
}

/**
 * Validates the whole set of personalization questions (this UI sends at
 * most 2, but the check generalizes). An empty array is always valid — no
 * personalization configured. Returns a user-facing error, or null.
 */
export function personalizationQuestionsError(questions: PersonalizationQuestionInput[]): string | null {
  if (questions.length === 0) return null;
  if (questions.length > PERSONALIZATION_MAX_QUESTIONS) {
    return `Etsy allows at most ${PERSONALIZATION_MAX_QUESTIONS} personalization questions per listing.`;
  }
  const uploadCount = questions.filter((q) => q.fieldType === "unlabeled_upload").length;
  if (uploadCount > 1) {
    return "Only one file-upload personalization field is allowed per listing.";
  }
  for (let i = 0; i < questions.length; i++) {
    const err = personalizationQuestionError(questions[i], `Personalization ${i + 1}`);
    if (err) return err;
  }
  return null;
}

export interface PersonalizationQuestionWire {
  question_id?: number;
  question_text: string;
  instructions?: string;
  question_type: PersonalizationFieldType;
  required: boolean;
  max_allowed_characters?: number;
  max_allowed_files?: number;
  options?: { label: string }[];
}

/** Maps one validated question to the exact shape `updateListingPersonalization` expects. */
export function toPersonalizationWire(q: PersonalizationQuestionInput): PersonalizationQuestionWire {
  const wire: PersonalizationQuestionWire = {
    question_text: q.questionText.trim().slice(0, PERSONALIZATION_QUESTION_TEXT_MAX),
    question_type: q.fieldType,
    required: q.required,
  };
  if (q.questionId != null) wire.question_id = q.questionId;
  if (q.fieldType === "text_input") {
    wire.max_allowed_characters = q.maxAllowedCharacters;
  } else if (q.fieldType === "unlabeled_upload") {
    wire.max_allowed_files = q.maxAllowedFiles;
  } else if (q.fieldType === "dropdown") {
    wire.options = q.options.map((o) => o.trim()).filter(Boolean).map((label) => ({ label }));
  }
  // Etsy rejects `instructions` on a dropdown question — omitted there regardless of state.
  if (q.fieldType !== "dropdown") {
    const instructions = q.instructions.trim().slice(0, PERSONALIZATION_INSTRUCTIONS_MAX);
    if (instructions) wire.instructions = instructions;
  }
  return wire;
}

import {
  type CheckInQuestion,
  type CheckInQuestionChild,
  type ChildCondition,
  type QuestionOption,
} from "./types";

export type QuestionFieldDefinition = {
  id: string;
  prompt: string;
  inputLabel?: string;
  inputType: CheckInQuestion["inputType"];
  analysisMode: CheckInQuestion["analysisMode"];
  min?: number;
  max?: number;
  step?: number;
  options?: QuestionOption[];
};

function parseNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseQuestionNumber(
  field: Pick<QuestionFieldDefinition, "inputType" | "options">,
  value: unknown,
): number | null {
  if (field.inputType === "multi-choice") {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value !== "string") {
      return null;
    }
    const normalized = value.trim();
    if (!normalized) {
      return null;
    }
    const option = field.options?.find((candidate) => candidate.id === normalized);
    if (option && typeof option.score === "number" && Number.isFinite(option.score)) {
      return option.score;
    }
    const numericOption = Number(normalized);
    return Number.isFinite(numericOption) ? numericOption : null;
  }
  return parseNumber(value);
}

function normalizeConditionValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.trim();
  }
  return value;
}

export function evaluateChildCondition(
  parent: QuestionFieldDefinition,
  condition: ChildCondition,
  parentValue: unknown,
): boolean {
  if (condition.operator === "non_empty") {
    if (typeof parentValue === "string") {
      return parentValue.trim().length > 0;
    }
    return parentValue !== null && parentValue !== undefined;
  }

  if (condition.operator === "greater_than" || condition.operator === "at_least") {
    const left = parseQuestionNumber(parent, parentValue);
    const right = parseNumber(condition.value);
    if (left === null || right === null) {
      return false;
    }
    return condition.operator === "greater_than" ? left > right : left >= right;
  }

  const left = normalizeConditionValue(parentValue);
  const right = normalizeConditionValue(condition.value);
  if (condition.operator === "equals") {
    return left === right;
  }
  return left !== right;
}

export function getVisibleChildren(
  question: CheckInQuestion,
  answers: Record<string, string | number | boolean>,
): CheckInQuestionChild[] {
  const children = question.children ?? [];
  if (!children.length) {
    return [];
  }
  const parent: QuestionFieldDefinition = {
    id: question.id,
    prompt: question.prompt,
    inputLabel: question.inputLabel,
    inputType: question.inputType,
    analysisMode: question.analysisMode,
    min: question.min,
    max: question.max,
    step: question.step,
    options: question.options,
  };
  const parentValue = answers[question.id];
  return children.filter((child) => evaluateChildCondition(parent, child.condition, parentValue));
}

export function pruneHiddenChildAnswers(
  questions: CheckInQuestion[],
  answers: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const nextAnswers = { ...answers };
  let changed = false;
  for (const question of questions) {
    const visibleChildren = new Set(getVisibleChildren(question, nextAnswers).map((child) => child.id));
    for (const child of question.children ?? []) {
      if (visibleChildren.has(child.id)) {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(nextAnswers, child.id)) {
        delete nextAnswers[child.id];
        changed = true;
      }
    }
  }
  return changed ? nextAnswers : answers;
}

export function flattenQuestionFields(questions: CheckInQuestion[]): QuestionFieldDefinition[] {
  const fields: QuestionFieldDefinition[] = [];
  for (const question of questions) {
    fields.push({
      id: question.id,
      prompt: question.prompt,
      inputLabel: question.inputLabel,
      inputType: question.inputType,
      analysisMode: question.analysisMode,
      min: question.min,
      max: question.max,
      step: question.step,
      options: question.options,
    });
    for (const child of question.children ?? []) {
      fields.push({
        id: child.id,
        prompt: child.prompt,
        inputType: child.inputType,
        analysisMode: child.analysisMode,
        min: child.min,
        max: child.max,
        step: child.step,
        options: child.options,
      });
    }
  }
  return fields;
}

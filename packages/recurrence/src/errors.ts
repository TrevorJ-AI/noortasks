export class RepeatFlagParseError extends Error {
  constructor(message: string, public readonly flag: string) {
    super(`${message}: ${flag}`);
    this.name = "RepeatFlagParseError";
  }
}

/** Thrown by occurrence generation for calendars (or rule features) that are not implemented. Never a wrong date. */
export class UnsupportedCalendarError extends Error {
  constructor(public readonly calendar: string, detail?: string) {
    super(`Calendar ${calendar} is not supported for occurrence generation${detail ? `: ${detail}` : ""}`);
    this.name = "UnsupportedCalendarError";
  }
}

export class UnsupportedRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedRuleError";
  }
}

export class InvalidRepeatRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRepeatRuleError";
  }
}

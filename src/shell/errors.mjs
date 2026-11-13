// Shell control-flow signals shared by the executor and the builtins.
export class ShellExit extends Error {
  constructor(code, message) {
    super(message === undefined ? '' : message);
    this.name = 'ShellExit';
    this.code = code;
  }
}

export class ShellBreak extends Error {
  constructor(count) { super('break'); this.name = 'ShellBreak'; this.count = count || 1; }
}

export class ShellContinue extends Error {
  constructor(count) { super('continue'); this.name = 'ShellContinue'; this.count = count || 1; }
}

export class ShellReturn extends Error {
  constructor(code) { super('return'); this.name = 'ShellReturn'; this.code = code; }
}

export class ShellAbort extends Error {
  constructor(reason) { super(reason); this.name = 'ShellAbort'; this.reason = reason; }
}

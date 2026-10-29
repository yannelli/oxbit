const OPERATORS = ['&&', '||', ';;', '$(', ';', '|', '&', '\n', '(', ')', '`'];
const WRAPPERS = new Set(['sudo', 'command', 'exec', 'time', 'nohup', 'env', 'builtin']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
const REDIRECT = /^(\d*|&)(>>?|<)/;
const REDIRECT_WITHOUT_TARGET = /^(\d*|&)(>>?|<)$/;

function isRedirectAmpersand(command, index) {
  return command[index] === '&' && (command[index - 1] === '>' || command[index - 1] === '<' || command[index + 1] === '>');
}

export function splitSegments(command) {
  const segments = [];
  let words = [];
  let word = '';
  let inWord = false;
  let quote = null;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && index + 1 < command.length) word += command[++index];
      else word += char;
      continue;
    }
    if (char === '\\') {
      if (command[index + 1] !== '\n') {
        word += command[index + 1] ?? '';
        inWord = true;
      }
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inWord = true;
      continue;
    }
    if (char === ' ' || char === '\t') {
      endWord();
      continue;
    }
    if (char === '#' && !inWord) {
      const newline = command.indexOf('\n', index);
      index = newline === -1 ? command.length : newline - 1;
      continue;
    }
    const operator = isRedirectAmpersand(command, index) ? null : OPERATORS.find((op) => command.startsWith(op, index));
    if (operator) {
      endSegment();
      index += operator.length - 1;
      continue;
    }
    word += char;
    inWord = true;
  }
  endSegment();
  return segments;
}

function stripPrefixes(words) {
  let index = 0;
  while (index < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]) || WRAPPERS.has(words[index]))) index += 1;
  return words.slice(index);
}

function dropRedirects(words) {
  const kept = [];
  for (let index = 0; index < words.length; index += 1) {
    if (REDIRECT_WITHOUT_TARGET.test(words[index])) index += 1;
    else if (!REDIRECT.test(words[index])) kept.push(words[index]);
  }
  return kept;
}

function programName(word) {
  return word.slice(word.lastIndexOf('/') + 1);
}

// Expands `bash -c "<script>"` so commands nested in a shell string get checked too.
export function simpleCommands(command, depth = 0) {
  const commands = [];
  for (const segment of splitSegments(command)) {
    const words = dropRedirects(stripPrefixes(segment));
    if (!words.length) continue;
    const flag = words.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(word));
    if (SHELLS.has(programName(words[0])) && flag > 0 && words[flag + 1] && depth < 3) {
      commands.push(...simpleCommands(words[flag + 1], depth + 1));
    } else {
      commands.push([programName(words[0]), ...words.slice(1)]);
    }
  }
  return commands;
}

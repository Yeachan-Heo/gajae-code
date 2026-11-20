import { redactCrashSecretsPreservingLines } from "@gajae-code/utils";

// Test 1: Header with folded value
const test1 = `Cookie:
 [
  "header-fold-canary"
]`;

console.log("Test 1 input:");
console.log(JSON.stringify(test1));
console.log("\nTest 1 output:");
const result1 = redactCrashSecretsPreservingLines(test1);
console.log(JSON.stringify(result1));
console.log("\nTest 1 actual output (readable):");
console.log(result1);

// Test 2: JSON with secret
const test2 = `{"secret": [
  "old-side-secret-canary-123"
]
}`;

console.log("\n\nTest 2 input:");
console.log(JSON.stringify(test2));
console.log("\nTest 2 output:");
const result2 = redactCrashSecretsPreservingLines(test2);
console.log(JSON.stringify(result2));
console.log("\nTest 2 actual output (readable):");
console.log(result2);

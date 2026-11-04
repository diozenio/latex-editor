export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      2,
      "always",
      ["app", "core", "mcp", "ui", "chat", "deps", "scripts", "release", "readme", "config"],
    ],
  },
};

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-module-cycles",
      severity: "error",
      from: { path: "^modules/" },
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: "(^|/)(node_modules|\\.agents|\\.claude)/",
    tsConfig: { fileName: "tsconfig.json" },
  },
};

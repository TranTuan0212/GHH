"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
// Load local development settings before any route module reads process.env.
// Deployment environments can still provide variables directly; those values
// take precedence over entries in .env.
const envFile = node_path_1.default.resolve(process.cwd(), '.env');
if (node_fs_1.default.existsSync(envFile)) {
    process.loadEnvFile(envFile);
}

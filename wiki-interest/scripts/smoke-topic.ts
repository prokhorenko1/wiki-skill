import { runTopicSmoke } from '../src/smoke-topic.js';
import { createServices } from '../src/research.js';
const result = await runTopicSmoke(createServices());
console.log(JSON.stringify(result));
if (result.status !== 'passed') process.exitCode = 1;

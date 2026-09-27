import { runLiveSmoke } from '../src/smoke-live.js';
import { createServices } from '../src/research.js';
import { runTopicSmoke } from '../src/smoke-topic.js';
const services = createServices();
const article = await runLiveSmoke(services), topic = await runTopicSmoke(services);
const result = { status: article.status === 'passed' && topic.status === 'passed' ? 'passed' : article.status === 'failed' || topic.status === 'failed' ? 'failed' : 'blocked', article, topic };
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status !== 'passed') process.exitCode = 1;

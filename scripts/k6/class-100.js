// A hybrid class of 100 students + every RL agent model + 40 bots. See README.md in this folder.
//   BASE_URL=https://carb-cap-trade-api.onrender.com HOST_KEY=… k6 run scripts/k6/class-100.js
import { makeTest } from './lib/hybrid-class.js'

const test = makeTest(100)
export const options = test.options
export const setup = test.setup
export const host = test.host
export const student = test.student
export const health = test.health

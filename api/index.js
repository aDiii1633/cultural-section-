// Vercel serverless entry. vercel.json sends /api/*, /export/* and /photo/* here.
module.exports = require('../lib/app').handle;

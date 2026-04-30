const express = require('express');
const app = express();
app.use(express.json());

// Import and mount the handler
const handler = require('./api/clickup-auth-web');
app.all('/api/clickup-auth-web', (req, res) => handler.default(req, res));

app.listen(process.env.PORT || 3000, () => console.log('Server running'));


const axios = require('axios');

async function triggerWebhook() {
    const payload = {
        repository: {
            id: 1135948896,
            name: 'server',
            full_name: 'harmilgoti/server',
            clone_url: 'https://github.com/harmilgoti/server.git',
            url: 'https://github.com/harmilgoti/server'
        },
        commits: [
            {
                id: 'api-test-commit',
                message: 'Update API routes',
                timestamp: new Date().toISOString(),
                // We simulate a change in a backend file that defines routes
                modified: ['src/routes.ts'],
                added: [],
                removed: []
            }
        ],
        before: 'HEAD~1',
        after: 'HEAD'
    };

    console.log('Sending API impact verification webhook...');
    try {
        const response = await axios.post('http://localhost:3001/webhook/github', payload);
        console.log('Webhook sent:', response.data);
    } catch (error) {
        console.error('Error sending webhook:', error.message);
        if (error.response) {
            console.error('Response data:', error.response.data);
        }
    }
}

triggerWebhook();

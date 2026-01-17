
const axios = require('axios');

async function triggerWebhook() {
    const payload = {
        repository: {
            name: 'demo-repo',
            full_name: 'test-user/demo-repo',
            clone_url: 'https://github.com/test-user/demo-repo.git',
            url: 'https://github.com/test-user/demo-repo'
        },
        commits: [
            {
                id: '1234567890',
                message: 'Update user API',
                timestamp: new Date().toISOString(),
                modified: ['src/api.ts'],
                added: [],
                removed: []
            }
        ],
        before: 'HEAD~1',
        after: 'HEAD'
    };

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

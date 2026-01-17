
import { PrismaClient } from '@prisma/client';
import axios from 'axios';

const prisma = new PrismaClient();
const API_URL = 'http://localhost:3001';

async function testResolution() {
    console.log('--- Testing Resolution API ---');

    // 1. Find a pending affected file
    const file = await prisma.affectedFile.findFirst({
        where: { status: 'PENDING' }
    });

    if (!file) {
        console.log('No pending files found. Run verify-impact.js first.');
        process.exit(1);
    }

    console.log(`Found pending file: ${file.filePath} (ID: ${file.id})`);

    // 2. Call API to resolve
    try {
        console.log(`Resolving file via API...`);
        const res = await axios.patch(`${API_URL}/impacts/file/${file.id}/status`, {
            status: 'RESOLVED'
        });

        console.log('API Response:', res.data);

        if (res.data.status === 'RESOLVED' && res.data.resolvedAt) {
            console.log('✅ File successfully resolved via API');
        } else {
            console.error('❌ API response incorrect');
        }

        // 3. Verify in DB
        const updated = await prisma.affectedFile.findUnique({ where: { id: file.id } });
        if (updated?.status === 'RESOLVED') {
            console.log('✅ Database updated correctly');
        } else {
            console.error('❌ Database verification failed');
        }

    } catch (error: any) {
        console.error('API Call failed:', error.message);
        if (error.response) {
            console.error('Response:', error.response.data);
        }
    } finally {
        await prisma.$disconnect();
    }
}

testResolution();

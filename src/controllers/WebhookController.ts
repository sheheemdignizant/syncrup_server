import { Request, Response } from 'express';
import crypto from 'crypto';
import { GitService } from '../services/GitService';
import { ImpactAnalyzer } from '../services/ImpactAnalyzer';
import { ProjectService } from '../services/ProjectService';
import { getIO } from '../services/SocketService';
import path from 'path';

const projectService = new ProjectService();

export class WebhookController {
    /**
     * Handle GitHub webhook push events
     */
    static async handleGitHub(req: Request, res: Response) {
        try {
            const signature = req.headers['x-hub-signature-256'] as string;
            let payload = req.body;

            // ngrok wraps the payload in a "payload" field as a string
            if (payload.payload && typeof payload.payload === 'string') {
                payload = JSON.parse(payload.payload);
            }

            // Verify webhook signature (optional but recommended)
            // const isValid = WebhookController.verifyGitHubSignature(payload, signature);
            // if (!isValid) {
            //     return res.status(401).json({ error: 'Invalid signature' });
            // }

            console.log('[WEBHOOK] Received GitHub push event');
            console.log('[WEBHOOK] Repository:', payload.repository?.full_name);
            console.log('[WEBHOOK] Commits:', payload.commits?.length);

            // Process the webhook
            await WebhookController.processGitHubPush(payload);

            res.json({ status: 'success', message: 'Webhook processed' });
        } catch (error) {
            console.error('[WEBHOOK] Error processing GitHub webhook:', error);
            res.status(500).json({ error: (error as Error).message });
        }
    }

    /**
     * Process GitHub push event
     */
    private static async processGitHubPush(payload: any) {
        console.log('[WEBHOOK] Full payload:', JSON.stringify(payload, null, 2));

        const repoUrl = payload.repository?.clone_url || payload.repository?.html_url || payload.repository?.url;
        const repoName = payload.repository?.name;
        const commits = payload.commits || [];

        console.log('[WEBHOOK] Repository URL:', repoUrl);
        console.log('[WEBHOOK] Repository Name:', repoName);
        console.log('[WEBHOOK] Commits count:', commits.length);

        if (!repoUrl || commits.length === 0) {
            console.log('[WEBHOOK] No commits or repository URL found');
            console.log('[WEBHOOK] Available payload keys:', Object.keys(payload));
            return;
        }

        // Find the project and repository in our database
        const allProjects = await projectService.getProjects();
        let targetProject = null;
        let targetRepo = null;

        for (const project of allProjects) {
            const repo = project.repos.find((r: any) => r.url === repoUrl || r.name === repoName);
            if (repo) {
                targetProject = project;
                targetRepo = repo;
                break;
            }
        }

        if (!targetProject || !targetRepo) {
            console.log('[WEBHOOK] Repository not found in any project');
            return;
        }

        console.log(`[WEBHOOK] Found repository in project: ${targetProject.name}`);

        // Get changed files from commits
        const changedFiles = new Set<string>();
        for (const commit of commits) {
            (commit.modified || []).forEach((f: string) => changedFiles.add(f));
            (commit.added || []).forEach((f: string) => changedFiles.add(f));
        }

        console.log(`[WEBHOOK] Changed files:`, Array.from(changedFiles));

        // Analyze impact for each changed file
        const impactAnalyzer = new ImpactAnalyzer();
        const io = getIO();

        for (const filePath of changedFiles) {
            // Skip non-code files
            if (!filePath.match(/\.(ts|tsx|js|jsx)$/)) {
                continue;
            }

            // Get old and new file content for AI analysis
            let oldContent: string | undefined;
            let newContent: string | undefined;

            try {
                const repoPath = `./repos/${targetRepo.id}`;
                const gitService = new GitService(repoPath);

                console.log(`[WEBHOOK] Syncing local repo ${targetRepo.id}...`);
                await gitService.pullLatestChanges();

                oldContent = await gitService.getFileContent(filePath, payload.before);
                newContent = await gitService.getFileContent(filePath, payload.after);

                console.log(`[WEBHOOK] Got file content for AI (old: ${oldContent?.length || 0} chars, new: ${newContent?.length || 0} chars)`);
            } catch (err) {
                console.log(`[WEBHOOK] Could not get file content:`, (err as Error).message);
            }

            const impact = await impactAnalyzer.analyzeFileChange(
                targetProject.id,
                targetRepo.id,
                filePath,
                oldContent,
                newContent
            );

            // Only emit if there are affected files
            if (impact.affectedFiles.length > 0) {
                console.log(`[WEBHOOK] Impact detected for ${filePath}:`, impact.affectedFiles.length, 'files affected');

                // Persist Result
                try {
                    // 1. Create Scan Record
                    const scan = await projectService.createScan(
                        targetRepo.id,
                        payload.after || 'unknown',
                        'COMPLETED'
                    );

                    // 2. Create Impact Report
                    await projectService.createImpactReport(scan.id, impact);
                    console.log(`[WEBHOOK] Impact persisted to DB for scan ${scan.id}`);
                } catch (dbError) {
                    console.error('[WEBHOOK] Failed to persist impact to DB:', dbError);
                }

                impact.affectedFiles.forEach(f => {
                    console.log(`  - ${f.filePath} (${f.reason})`);
                });

                // Emit WebSocket event
                io.emit('impact:detected', impact);

                // ALSO Emit repository:updated so history panel refreshes
                // We need to fetch the Full repo with scans to send the update
                const updatedRepo = await projectService.getRepo(targetRepo.id);
                if (updatedRepo) {
                    io.emit('repository:updated', {
                        projectId: targetProject.id,
                        repository: updatedRepo
                    });
                }
            }
        }
    }

    /**
     * Verify GitHub webhook signature
     */
    private static verifyGitHubSignature(payload: any, signature: string): boolean {
        const secret = process.env.GITHUB_WEBHOOK_SECRET || '';
        if (!secret) return true; // Skip verification if no secret configured

        const hmac = crypto.createHmac('sha256', secret);
        const digest = 'sha256=' + hmac.update(JSON.stringify(payload)).digest('hex');

        return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
    }

    /**
     * Handle GitLab webhook push events
     */
    static async handleGitLab(req: Request, res: Response) {
        try {
            const token = req.headers['x-gitlab-token'] as string;
            const payload = req.body;

            // Verify token (optional)
            // if (token !== process.env.GITLAB_WEBHOOK_TOKEN) {
            //     return res.status(401).json({ error: 'Invalid token' });
            // }

            console.log('[WEBHOOK] Received GitLab push event');

            // Similar processing as GitHub
            // Implementation would be similar to processGitHubPush

            res.json({ status: 'success', message: 'Webhook processed' });
        } catch (error) {
            console.error('[WEBHOOK] Error processing GitLab webhook:', error);
            res.status(500).json({ error: (error as Error).message });
        }
    }
}

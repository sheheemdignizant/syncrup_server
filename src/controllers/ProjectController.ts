import { Request, Response } from 'express';
import { ProjectService } from '../services/ProjectService';
import { IndexerService } from '../services/IndexerService';
import { GraphService } from '../services/GraphService';
import { getIO } from '../services/SocketService';

const projectService = new ProjectService();

export class ProjectController {

    static async createProject(req: Request, res: Response) {
        try {
            const { name } = req.body;
            const project = await projectService.createProject(name);
            res.json(project);
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }

    static async getProjects(req: Request, res: Response) {
        try {
            const projects = await projectService.getProjects();
            res.json(projects);
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }

    static async addRepo(req: Request, res: Response) {
        try {
            const { projectId, name, url, type } = req.body;

            // Determine initial status: SERVER -> PENDING (Index now), OTHERS -> UNTRACKED (Index later)
            const initialStatus = type === 'SERVER' ? 'PENDING' : 'UNTRACKED';

            const repo = await projectService.addRepo(projectId, name, url, type, initialStatus);

            console.log(`[CONTROLLER] Repository added: ${repo.id} - ${name} (${initialStatus})`);
            const io = getIO();
            io.emit('repository:added', { projectId, repository: repo });

            // Only trigger indexing if it's a SERVER repo
            if (type === 'SERVER') {
                console.log(`[CONTROLLER] Starting background indexing for project ${projectId}...`);

                // Create project-specific graph service and indexer
                const graphService = new GraphService(projectId);
                const indexerService = new IndexerService(graphService);

                // Trigger indexing in background
                indexerService.cloneAndIndex(url, repo.id, repo.branch)
                    .then(async () => {
                        console.log(`[CONTROLLER] ✅ Indexing successful for ${repo.id}, updating status to INDEXED`);
                        const updatedRepo = await projectService.updateRepoStatus(repo.id, 'INDEXED');

                        // Emit status update event
                        io.emit('repository:updated', { projectId, repository: updatedRepo });
                        io.emit('graph:updated', { projectId });
                    })
                    .then(() => {
                        console.log(`[CONTROLLER] ✓ Status updated to INDEXED for ${repo.id}`);
                    })
                    .catch(async (err) => {
                        console.error(`[CONTROLLER] ❌ Indexing failed for ${repo.id}:`, err);
                        const failedRepo = await projectService.updateRepoStatus(repo.id, 'FAILED');

                        // Emit failure event
                        io.emit('repository:updated', { projectId, repository: failedRepo });
                    });
            } else {
                console.log(`[CONTROLLER] Skipping indexing for ${type} repo ${repo.id} (Status: UNTRACKED). waiting for connection.`);
            }

            res.json(repo);
        } catch (error) {
            const msg = (error as Error).message;
            if (msg.startsWith('SERVER_REQUIRED')) {
                res.status(400).json({ error: msg });
            } else {
                res.status(500).json({ error: msg });
            }
        }
    }

    static async createDependency(req: Request, res: Response) {
        try {
            const { sourceRepoId, targetRepoId } = req.body;
            const dep = await projectService.addDependency(sourceRepoId, targetRepoId);

            // Workflow: When connecting Server -> Web/Mobile, trigger indexing for the Target (Web/Mobile)
            // 1. Get Target Repo
            const targetRepo = await projectService.getRepo(targetRepoId);

            if (targetRepo && targetRepo.status === 'UNTRACKED') {
                console.log(`[CONTROLLER] Connection established. Triggering indexing for tied repo ${targetRepo.name}...`);
                const io = getIO();

                // Update to PENDING
                const pendingRepo = await projectService.updateRepoStatus(targetRepo.id, 'PENDING');
                io.emit('repository:updated', { projectId: pendingRepo.projectId, repository: pendingRepo });

                // Start Indexing
                const graphService = new GraphService(pendingRepo.projectId);
                const indexerService = new IndexerService(graphService);

                indexerService.cloneAndIndex(pendingRepo.url, pendingRepo.id, pendingRepo.branch)
                    .then(async () => {
                        console.log(`[CONTROLLER] ✅ Indexing successful for ${pendingRepo.id}`);
                        const indexedRepo = await projectService.updateRepoStatus(pendingRepo.id, 'INDEXED');
                        io.emit('repository:updated', { projectId: pendingRepo.projectId, repository: indexedRepo });
                        io.emit('graph:updated', { projectId: pendingRepo.projectId });
                    })
                    .catch(async (err) => {
                        console.error(`[CONTROLLER] ❌ Indexing failed for ${pendingRepo.id}:`, err);
                        const failedRepo = await projectService.updateRepoStatus(pendingRepo.id, 'FAILED');
                        io.emit('repository:updated', { projectId: pendingRepo.projectId, repository: failedRepo });
                    });
            }

            res.json(dep);
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }

    static async deleteDependency(req: Request, res: Response) {
        try {
            const { sourceRepoId, targetRepoId } = req.body;
            await projectService.removeDependency(sourceRepoId, targetRepoId);

            console.log(`[CONTROLLER] Removed dependency ${sourceRepoId} -> ${targetRepoId}`);

            // Logic: Check if target repo is now orphaned (no incoming deps)
            const incomingCount = await projectService.countIncomingDependencies(targetRepoId);

            if (incomingCount === 0) {
                const targetRepo = await projectService.getRepo(targetRepoId);
                // Only revert if it's NOT a server repo (Servers stand alone)
                if (targetRepo && targetRepo.type !== 'SERVER') {
                    console.log(`[CONTROLLER] Repo ${targetRepo.name} is now orphaned. Reverting to UNTRACKED and clearing data.`);

                    // 1. Revert Status
                    const untrackedRepo = await projectService.updateRepoStatus(targetRepo.id, 'UNTRACKED');
                    const io = getIO();
                    io.emit('repository:updated', { projectId: untrackedRepo.projectId, repository: untrackedRepo });

                    // 2. Clear Graph Data
                    const graphService = new GraphService(untrackedRepo.projectId);
                    graphService.removeNodesByRepoId(targetRepo.id);
                    io.emit('graph:updated', { projectId: untrackedRepo.projectId });
                }
            }

            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }

    static async getGraph(req: Request, res: Response) {
        try {
            const { projectId } = req.query;
            const graphService = new GraphService(projectId as string);
            const graph = graphService.getGraph();

            // Merge manual dependencies from DB
            const dbDeps = await projectService.getDependencies(projectId as string);
            const entryEdges = dbDeps.map(d => ({
                source: d.sourceRepoId, // Node ID is simply Repo ID for high level
                target: d.targetRepoId,
                type: 'MANUAL'
            }));

            // We might need to adjust how the frontend expects edges. 
            // The frontend expects "repoId:filePath".
            // But for high-level visualization, we want Repo-to-Repo edges.
            // The current GraphService returns File-to-File edges.
            // We'll append these high-level edges.
            // Note: The frontend ProjectDetailView filters edges by splitting on ':'.
            // So if we send "RepoID", it implies "RepoID:undefined".
            // Let's send them purely as RepoID and handle in frontend or assume frontend handles "RepoID" source.

            res.json({
                nodes: graph.nodes,
                edges: [...graph.edges, ...entryEdges]
            });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }
}

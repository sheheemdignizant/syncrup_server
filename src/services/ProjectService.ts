
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class ProjectService {
    async createProject(name: string) {
        return prisma.project.create({
            data: { name },
        });
    }

    async getProjects() {
        return prisma.project.findMany({
            include: {
                repos: {
                    include: {
                        scans: {
                            include: {
                                impactReports: true
                            }
                        }
                    }
                }
            },
        });
    }

    async addRepo(projectId: string, name: string, url: string, type: 'SERVER' | 'WEB' | 'MOBILE', status: string = 'PENDING') {
        // Validation: Enforce Server-First
        if (type === 'WEB' || type === 'MOBILE') {
            const hasServer = await this.checkServerRepoExists(projectId);
            if (!hasServer) {
                throw new Error('SERVER_REQUIRED: You must add a Server/Backend repository first before adding Web or Mobile clients.');
            }
        }

        return prisma.repository.create({
            data: {
                projectId,
                name,
                url,
                type,
                status,
            },
        });
    }

    async checkServerRepoExists(projectId: string): Promise<boolean> {
        const count = await prisma.repository.count({
            where: {
                projectId,
                type: 'SERVER'
            }
        });
        return count > 0;
    }

    async addDependency(sourceRepoId: string, targetRepoId: string) {
        // Validation: Only Server -> Web/Mobile allowed (or Web/Mobile -> Server depending on perspective, usually Client depends on Server)
        // User said: "web to server... without connect web to server"
        // And: "edge connection will work like server can connect with web/mobile"
        // Let's allow creating the link. Directionality is usually Client -> Server (Depends On), or Server -> Client (Impacts).
        // React Flow usually visualizes "Updates flow from Server to Client". So Edge Source = Server, Target = Client.

        const source = await this.getRepo(sourceRepoId);
        const target = await this.getRepo(targetRepoId);

        if (!source || !target) throw new Error('Repository not found');

        // Enforce topology rules if needed, but for now just persist
        return prisma.repoDependency.create({
            data: {
                sourceRepoId,
                targetRepoId
            }
        });
    }

    async getDependencies(projectId: string) {
        return prisma.repoDependency.findMany({
            where: {
                sourceRepo: { projectId }
            },
            include: {
                sourceRepo: true,
                targetRepo: true
            }
        });
    }

    async removeDependency(sourceRepoId: string, targetRepoId: string) {
        return prisma.repoDependency.deleteMany({
            where: {
                sourceRepoId,
                targetRepoId
            }
        });
    }

    async countIncomingDependencies(repoId: string): Promise<number> {
        return prisma.repoDependency.count({
            where: {
                targetRepoId: repoId
            }
        });
    }

    async getRepo(id: string) {
        return prisma.repository.findUnique({
            where: { id },
            include: {
                scans: {
                    include: {
                        impactReports: true
                    }
                }
            }
        });
    }

    async createScan(repoId: string, commitHash: string, status: string) {
        return prisma.scan.create({
            data: {
                repoId,
                commitHash,
                status,
                completedAt: status === 'COMPLETED' ? new Date() : null
            }
        });
    }

    async createImpactReport(scanId: string, summary: any) {
        return prisma.impactReport.create({
            data: {
                scanId,
                summary: JSON.stringify(summary)
            }
        });
    }

    async updateRepoStatus(id: string, status: string) {
        return prisma.repository.update({
            where: { id },
            data: { status },
        });
    }
}

import { Request, Response } from 'express';
import { ProjectService } from '../services/ProjectService';
import { getIO } from '../services/SocketService';

const projectService = new ProjectService();

export class ImpactController {

    /**
     * Update the status of an affected file (RESOLVE, REJECT, PENDING)
     */
    static async updateFileStatus(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const { status } = req.body;

            if (!['PENDING', 'RESOLVED', 'REJECTED'].includes(status)) {
                return res.status(400).json({ error: 'Invalid status. Must be PENDING, RESOLVED, or REJECTED.' });
            }

            console.log(`[IMPACT] Updating affected file ${id} to ${status}`);

            const updatedFile = await projectService.updateAffectedFileStatus(id, status);
            const io = getIO();

            // Broadcase real-time update
            // Frontend can listen to this and remove/update the item from the list
            io.emit('affected-file:updated', {
                id: updatedFile.id,
                repoId: updatedFile.repoId,
                status: updatedFile.status,
                impactReportId: updatedFile.impactReportId
            });

            res.json(updatedFile);
        } catch (error) {
            console.error('[IMPACT] Failed to update file status:', error);
            res.status(500).json({ error: (error as Error).message });
        }
    }
}

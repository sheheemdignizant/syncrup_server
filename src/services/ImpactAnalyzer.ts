import { GraphService } from './GraphService';
import { AIService } from './AIService';
import path from 'path';

export interface ImpactResult {
    projectId: string;
    changedFile: string;
    changedRepo: string;
    affectedFiles: Array<{
        repoId: string;
        filePath: string;
        reason: string;
        context?: string; // Code snippet showing usage
    }>;
    diff?: {
        oldContent: string;
        newContent: string;
    };
    isBreaking: boolean;
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    explanation: string;
    timestamp: string;
}

export class ImpactAnalyzer {
    private aiService: AIService;

    constructor() {
        this.aiService = new AIService();
    }

    /**
     * Analyze impact of a file change
     */
    async analyzeFileChange(
        projectId: string,
        repoId: string,
        filePath: string,
        oldContent?: string,
        newContent?: string
    ): Promise<ImpactResult> {
        console.log(`[IMPACT] Analyzing impact for ${filePath} in repo ${repoId}`);

        // Load project graph
        const graphService = new GraphService(projectId);
        const graph = graphService.getGraph();

        // Normalize file path (handle both / and \)
        const normalizedPath = filePath.replace(/\\/g, '/');

        // Try multiple node ID formats
        const possibleNodeIds = [
            `${repoId}:${normalizedPath}`,
            `${repoId}:${filePath}`,
            `${repoId}:${filePath.replace(/\//g, '\\')}`,
        ];

        console.log(`[IMPACT] Looking for node IDs:`, possibleNodeIds);

        // Find the changed file node
        let changedNode = null;
        let changedNodeId = '';

        for (const nodeId of possibleNodeIds) {
            changedNode = graph.nodes.find(n => n.id === nodeId);
            if (changedNode) {
                changedNodeId = nodeId;
                console.log(`[IMPACT] Found node with ID: ${nodeId}`);
                break;
            }
        }

        if (!changedNode) {
            console.log(`[IMPACT] Changed file not found in graph. Available nodes:`,
                graph.nodes.filter(n => n.id.includes(repoId)).map(n => n.id).slice(0, 5));
            return this.createEmptyResult(projectId, repoId, filePath);
        }

        // Find all files that depend on this file (reverse dependencies from graph)
        const graphAffectedFiles = this.findAffectedFiles(graph, changedNodeId, repoId);

        // AI-powered analysis: Single call to get both changed functions and severtiy
        let semanticAffectedFiles: Array<{ repoId: string; filePath: string; reason: string }> = [];
        let isBreaking = false;
        let explanation = 'File modified';

        if (oldContent && newContent) {
            console.log('[IMPACT-AI] Sending consolidated prompt to AI...');

            const prompt = `Analyze these code changes and provide two things:
1. A list of changed identifiers (function names, class names, or API paths).
2. Whether this is a breaking API change.

STRICT DEFINITION OF BREAKING CHANGE:
- Renaming an exported function.
- Changing the runtime structure of the return value (e.g., returning an object instead of an array).
- Adding a required argument.
- Removing an argument.
- modifying an API endpoint response structure.

NON-BREAKING CHANGES (DO NOT REPORT AS BREAKING):
- Changing a specific type to 'any' or 'unknown' (Type widening is NOT breaking).
- Adding an optional argument.
- Internal logic changes that do not affect the output structure.
- Refactoring or code cleanup.

IMPORTANT FOR "changedFunctions":
- Return EXACT SEARCHABLE STRINGS that other files would use to call this code.
- If a named function changed, return the EXACT function name (e.g., "getUser", "calculateTotal").
- If an API endpoint changed, return the EXACT URL path string used in the route definition (e.g., "/users", "/api/v1/login").
- DO NOT return descriptive names like "POST /users handler" or "User Controller".
- DO NOT return generic terms like "anonymous function".

OLD CODE:
\`\`\`
${oldContent.substring(0, 2000)}
\`\`\`

NEW CODE:
\`\`\`
${newContent.substring(0, 2000)}
\`\`\`

Respond ONLY with valid JSON in this format:
{
  "changedFunctions": ["funcName1", "/api/path"],
  "isBreaking": true/false,
  "explanation": "Brief explanation of why it is breaking or not"
}
If no functions changed, set "changedFunctions" to [].`;

            try {
                const aiResponse = await this.aiService.generateContent(prompt);
                console.log('[IMPACT-AI] Raw Response:', aiResponse);

                // Extract JSON
                const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const result = JSON.parse(jsonMatch[0]);
                    isBreaking = result.isBreaking || false;
                    explanation = result.explanation || 'Analyzed by AI';

                    const changedFunctions = result.changedFunctions || [];
                    console.log('[IMPACT-AI] Parsed changed functions:', changedFunctions);

                    if (changedFunctions.length > 0) {
                        semanticAffectedFiles = await this.searchForAffectedFiles(
                            graph,
                            repoId,
                            changedFunctions
                        );
                    }
                }
            } catch (err) {
                console.error('[IMPACT-AI] Analysis failed:', err);
            }
        }

        // Combine both types of affected files
        const allAffectedFiles = [...graphAffectedFiles, ...semanticAffectedFiles];

        // Remove duplicates with strict normalization
        const uniqueAffectedFiles = Array.from(
            new Map(allAffectedFiles.map(f => {
                // Normalize both repoId and filePath to ensure strict uniqueness
                // Handle Windows/Unix path differences
                const normalizedPath = f.filePath.replace(/\\/g, '/').toLowerCase();
                return [`${f.repoId}:${normalizedPath}`, f];
            })).values()
        );





        if (!isBreaking) {
            console.log('[IMPACT] Change classified as non-breaking. Ignoring affected files as per configuration.');
            return {
                projectId,
                changedFile: filePath,
                changedRepo: repoId,
                affectedFiles: [],
                isBreaking,
                severity: 'LOW',
                explanation: explanation || 'Non-breaking change detected',
                timestamp: new Date().toISOString()
            };
        }

        // Determine severity
        const severity = this.determineSeverity(uniqueAffectedFiles.length, isBreaking);

        console.log(`[IMPACT] Found ${uniqueAffectedFiles.length} total affected files (${graphAffectedFiles.length} from graph + ${semanticAffectedFiles.length} from AI), Breaking: ${isBreaking}, Severity: ${severity}`);

        uniqueAffectedFiles.forEach(f => {
            console.log(`  > Affected: ${f.filePath} [${f.reason}]`);
        });

        return {
            projectId,
            changedFile: filePath,
            changedRepo: repoId,
            affectedFiles: uniqueAffectedFiles,
            isBreaking,
            severity,
            explanation,
            timestamp: new Date().toISOString(),
            diff: (oldContent && newContent) ? { oldContent, newContent } : undefined
        };
    }

    /**
     * Search for files that use the changed functions
     */
    private async searchForAffectedFiles(
        graph: any,
        sourceRepoId: string,
        changedFunctions: string[]
    ): Promise<Array<{ repoId: string; filePath: string; reason: string; context?: string }>> {
        console.log(`[IMPACT-AI] Scanning for usages of: ${changedFunctions.join(', ')}`);

        // Filter valid function names to avoid false positives
        const functionList = changedFunctions.map(f => f.trim()).filter(f => f.length > 2);

        if (functionList.length === 0) return [];

        // Get all files from other repositories
        const otherRepoFiles = graph.nodes.filter((n: any) =>
            n.type === 'FILE' &&
            !n.id.startsWith(sourceRepoId) &&
            n.id.match(/\.(ts|tsx|js|jsx)$/)
        );

        const affectedFiles: Array<{ repoId: string; filePath: string; reason: string; context?: string }> = [];

        // Check files (increased limit for better coverage)
        const limit = 500;
        const processedFiles = new Set<string>();
        console.log(`[IMPACT-AI] Checking up to ${limit} files (found ${otherRepoFiles.length} candidates)`);

        for (const file of otherRepoFiles.slice(0, limit)) {
            // Normalize ID for checking
            const normalizedId = file.id.replace(/\\/g, '/').toLowerCase();
            if (processedFiles.has(normalizedId)) continue;
            processedFiles.add(normalizedId);

            const [fileRepoId, ...pathParts] = file.id.split(':');
            const filePathStr = pathParts.join(':');

            try {
                const repoPath = path.join(process.cwd(), 'repos', fileRepoId);
                const normalizedFilePath = filePathStr.replace(/\\/g, path.sep).replace(/\//g, path.sep);
                const absoluteFilePath = path.join(repoPath, normalizedFilePath);

                const fs = require('fs');
                if (!fs.existsSync(absoluteFilePath)) {
                    // console.warn(`[IMPACT-AI] File not found on disk: ${absoluteFilePath}`);
                    continue;
                }

                const fileContent = fs.readFileSync(absoluteFilePath, 'utf-8');
                const lines = fileContent.split('\n');
                const addedUsagesForFile = new Set<string>();

                for (const fn of functionList) {
                    // Use word boundary regex for more accurate matching where appropriate
                    // Only apply \b if the identifier starts/ends with a word character
                    const escapedFn = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const prefix = /^\w/.test(fn) ? '\\b' : '';
                    const suffix = /\w$/.test(fn) ? '\\b' : '';
                    const regex = new RegExp(`${prefix}${escapedFn}${suffix}`);

                    if (regex.test(fileContent)) {
                        for (let i = 0; i < lines.length; i++) {
                            if (regex.test(lines[i])) {
                                const usage = `${fn} (line ${i + 1})`;
                                if (!addedUsagesForFile.has(usage)) {
                                    addedUsagesForFile.add(usage);

                                    // Extract context (2 lines before and after)
                                    const startLine = Math.max(0, i - 2);
                                    const endLine = Math.min(lines.length - 1, i + 2);
                                    const contextSnippet = lines.slice(startLine, endLine + 1)
                                        .map((l: string, idx: number) => {
                                            const originalLineNum = startLine + idx + 1;
                                            const marker = originalLineNum === (i + 1) ? '> ' : '  ';
                                            return `${marker}${originalLineNum}: ${l}`;
                                        })
                                        .join('\n');

                                    affectedFiles.push({
                                        repoId: fileRepoId,
                                        filePath: filePathStr.replace(/\\/g, '/'),
                                        reason: `Uses modified function: ${fn}`,
                                        context: contextSnippet
                                    });
                                    // Found a usage for this function in this file, move to next function or next file?
                                    // We want all usages, but maybe one per function per file is enough for the alert?
                                    // Let's break the line loop for this function, so we don't report every single line
                                    break;
                                }
                            }
                        }
                    }
                }
            } catch (err) {
                console.error(`[IMPACT-AI] Error reading file ${file.id}:`, err);
            }
        }

        return affectedFiles;
    }

    /**
     * Find all files affected by a change
     */
    private findAffectedFiles(graph: any, changedNodeId: string, sourceRepoId: string) {
        const affected: Array<{ repoId: string; filePath: string; reason: string; context?: string }> = [];
        const visited = new Set<string>();

        // BFS to find all dependent files
        const queue = [changedNodeId];
        visited.add(changedNodeId);

        while (queue.length > 0) {
            const currentNodeId = queue.shift()!;

            // Find all edges where current node is the target (reverse dependency)
            const dependentEdges = graph.edges.filter((e: any) => e.target === currentNodeId && e.type === 'IMPORTS');

            for (const edge of dependentEdges) {
                if (!visited.has(edge.source)) {
                    visited.add(edge.source);
                    queue.push(edge.source);

                    // Extract repo and file path
                    const [edgeRepoId, ...pathParts] = edge.source.split(':');
                    const edgeFilePath = pathParts.join(':');

                    // Only include files from different repos
                    if (edgeRepoId !== sourceRepoId) {
                        const node = graph.nodes.find((n: any) => n.id === edge.source);
                        affected.push({
                            repoId: edgeRepoId,
                            filePath: edgeFilePath,
                            reason: `Imports ${path.basename(changedNodeId)}`
                        });
                    }
                }
            }
        }

        return affected;
    }

    /**
     * Determine severity based on impact
     */
    private determineSeverity(affectedCount: number, isBreaking: boolean): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
        if (isBreaking && affectedCount > 5) return 'CRITICAL';
        if (isBreaking && affectedCount > 0) return 'HIGH';
        if (affectedCount > 10) return 'HIGH';
        if (affectedCount > 5) return 'MEDIUM';
        return 'LOW';
    }

    /**
     * Create empty result when file not found
     */
    private createEmptyResult(projectId: string, repoId: string, filePath: string): ImpactResult {
        return {
            projectId,
            changedFile: filePath,
            changedRepo: repoId,
            affectedFiles: [],
            isBreaking: false,
            severity: 'LOW',
            explanation: 'File not found in dependency graph',
            timestamp: new Date().toISOString()
        };
    }
}

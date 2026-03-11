import process from 'node:process'

import {createAppContext} from '../runtime/app-context.mjs'
import {createConfigurationService} from '../application/configuration/service.mjs'
import {selectDeploymentTarget as selectDeploymentTargetImpl} from '../application/configuration/select-deployment-target.mjs'

const appContext = createAppContext()
const {
    logSuccess,
    logWarning,
    logProcessing,
    runPrompt
} = appContext
const configurationService = createConfigurationService(appContext)

export async function selectDeploymentTarget({rootDir = process.cwd()} = {}) {
    return selectDeploymentTargetImpl(rootDir, {
        configurationService,
        runPrompt,
        logProcessing,
        logSuccess,
        logWarning
    })
}

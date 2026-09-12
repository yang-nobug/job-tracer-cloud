import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const configuredDataDir = process.env.JOB_TRACER_DATA_DIR?.trim()

export const DATA_DIR = configuredDataDir ? path.resolve(configuredDataDir) : path.resolve(__dirname, '../../data')
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads')
export const REVIEWS_DIR = path.join(DATA_DIR, 'reviews')
export const KNOWLEDGE_IMAGES_DIR = path.join(DATA_DIR, 'knowledge_images')
export const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings')
export const APPLICATION_MATERIALS_DIR = path.join(DATA_DIR, 'application_materials')
/** 云端工作区文件。该目录不被 Nginx 作为静态资源暴露，只能经鉴权接口读取。 */
export const WORKSPACE_FILES_DIR = path.join(DATA_DIR, 'workspace_files')
export const WORKSPACE_RESUMES_DIR = path.join(WORKSPACE_FILES_DIR, 'resumes')
/** 面经截图也属于用户私有材料，不能继续放在旧的全局 knowledge_images 目录。 */
export const WORKSPACE_KNOWLEDGE_IMAGES_DIR = path.join(WORKSPACE_FILES_DIR, 'knowledge_images')

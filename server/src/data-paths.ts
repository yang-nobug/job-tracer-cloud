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
/** 录音为大文件，按工作区保存在私有磁盘，不进入 PostgreSQL 或静态目录。 */
export const WORKSPACE_RECORDINGS_DIR = path.join(WORKSPACE_FILES_DIR, 'recordings')
/** 面经截图也属于用户私有材料，不能继续放在旧的全局 knowledge_images 目录。 */
export const WORKSPACE_KNOWLEDGE_IMAGES_DIR = path.join(WORKSPACE_FILES_DIR, 'knowledge_images')
/** 招聘信息智能录入的原始材料，仅经当前工作区的鉴权接口预览。 */
export const WORKSPACE_APPLICATION_MATERIALS_DIR = path.join(WORKSPACE_FILES_DIR, 'application_materials')
/** 项目源码压缩包只供当前工作区建立只读索引，不作为静态文件暴露。 */
export const WORKSPACE_PROJECT_ARCHIVES_DIR = path.join(WORKSPACE_FILES_DIR, 'project_archives')

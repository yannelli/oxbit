import fs from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import standalone from 'ajv/dist/standalone/index.js';
const text = {type:'string', minLength:1, maxLength:4096};
const id = {...text, pattern:'^[a-zA-Z0-9_.-]+$'};
const map = {type:'object', additionalProperties:text};
const percent = {type:'string', pattern:'^(?:[1-9][0-9]?|[12][0-9]{2}|300)%$'};
const associations = Object.fromEntries(['file','folder','folderExpanded','rootFolder','rootFolderExpanded'].map(k=>[k,text]));
for(const k of ['fileNames','fileExtensions','languageIds','folderNames','folderNamesExpanded','rootFolderNames','rootFolderNamesExpanded']) associations[k]=map;
const font = {type:'object',required:['id','src'],properties:{id,src:{type:'array',minItems:1,maxItems:8,items:{type:'object',required:['path','format'],properties:{path:text,format:{enum:['woff','woff2','truetype','opentype']}},additionalProperties:false}},size:percent,weight:{type:'string',pattern:'^(normal|bold|[1-9]00)$'},style:{enum:['normal','italic','oblique']}},additionalProperties:false};
const glyph = {fontCharacter:{type:'string',minLength:1,maxLength:8},fontId:id};
const definition = {type:'object',properties:{iconPath:text,...glyph,fontColor:{type:'string',pattern:'^#[0-9a-fA-F]{3,8}$'},fontSize:percent},anyOf:[{required:['iconPath']},{required:['fontCharacter']}],additionalProperties:false};
const themeEntry={type:'array',maxItems:100,items:{type:'object',required:['id','path'],properties:{id,label:text,path:text},additionalProperties:true}};
const schemas={
 manifest:{type:'object',required:['publisher','name','version','contributes'],properties:{publisher:id,name:id,version:text,displayName:text,description:{type:'string'},license:text,contributes:{type:'object',properties:{iconThemes:themeEntry,productIconThemes:themeEntry},anyOf:[{required:['iconThemes']},{required:['productIconThemes']}],additionalProperties:true}},additionalProperties:true},
 file:{type:'object',required:['iconDefinitions'],properties:{$schema:text,iconDefinitions:{type:'object',additionalProperties:definition},fonts:{type:'array',maxItems:100,items:font},...associations,light:{type:'object',properties:associations,additionalProperties:false},highContrast:{type:'object',properties:associations,additionalProperties:false},hidesExplorerArrows:{type:'boolean'},showLanguageModeIcons:{type:'boolean'}},additionalProperties:true},
 product:{type:'object',required:['iconDefinitions'],properties:{$schema:text,iconDefinitions:{type:'object',additionalProperties:definition},fonts:{type:'array',maxItems:100,items:font}},additionalProperties:true}
};
const ajv=new Ajv2020({code:{source:true,esm:true},allErrors:true,strict:false,unicode:false});
for(const [name,schema] of Object.entries(schemas)){
 schema.$schema='https://json-schema.org/draft/2020-12/schema';
 schema.$id=`https://oxbit.dev/schemas/icon-${name}.v1.schema.json`;
 const contents=JSON.stringify(schema,null,2)+'\n';
 await fs.mkdir('packages/icon-themes/src/schemas',{recursive:true});
 await fs.writeFile(`packages/icon-themes/src/schemas/icon-${name}.v1.schema.json`,contents);
 await fs.writeFile(`apps/web/public/schemas/icon-${name}.v1.schema.json`,contents);
 const code=standalone(ajv,ajv.compile(schema));
 // Standalone output uses no eval; TypeScript declarations are supplied alongside.
 await fs.writeFile(`packages/icon-themes/src/validate-${name}.js`,'/* eslint-disable */\n'+code);
 await fs.writeFile(`packages/icon-themes/src/validate-${name}.d.ts`,'declare const validate: ((value: unknown) => boolean) & { errors?: {instancePath?: string; message?: string}[] | null };\nexport default validate;\n');
}

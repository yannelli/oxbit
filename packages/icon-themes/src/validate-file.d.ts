declare const validate: ((value: unknown) => boolean) & { errors?: {instancePath?: string; message?: string}[] | null };
export default validate;

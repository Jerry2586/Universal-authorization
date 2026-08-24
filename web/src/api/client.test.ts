import { describe,expect,it } from 'vitest'; import { queryString } from './client';
describe('API 客户端',()=>{it('只序列化有效筛选参数',()=>{expect(queryString({limit:50,status:'ACTIVE',empty:'',skip:undefined})).toBe('?limit=50&status=ACTIVE')})});

import { expect, it } from 'vitest';
import { workspaceTree } from '../src/workspaceTree';

it('groups nested files and sorts directories before files without losing paths or status', () => {
  const tree = workspaceTree([{path:'README.md',status:''},{path:'src/ui/Icon.tsx',status:' M'},{path:'src/App.tsx',status:''}]);
  expect(tree.map(node=>node.path)).toEqual(['src','README.md']);
  expect(tree[0].children?.map(node=>node.path)).toEqual(['src/ui','src/App.tsx']);
  expect(tree[0].children?.[0].children?.[0]).toMatchObject({path:'src/ui/Icon.tsx',status:' M'});
});
it('includes empty folders reported by the workspace', () => {
  expect(workspaceTree([], ['empty','nested/empty'])[1].children?.[0]).toMatchObject({path:'nested/empty',children:[]});
});

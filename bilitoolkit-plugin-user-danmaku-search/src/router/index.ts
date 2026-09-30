import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'

export const appMenus: Array<RouteRecordRaw & { title: string }> = [
  {
    title: '用户弹幕查询',
    path: '/UserDanmakuSearch',
    name: 'UserDanmakuSearch',
    component: () => import('../views/UserDanmakuSearch.vue'),
  },
  {
    title: '本地弹幕采集',
    path: '/LocalDanmakuCapture',
    name: 'LocalDanmakuCapture',
    component: () => import('../views/LocalDanmakuCapture.vue'),
  },
  {
    title: '本地弹幕记录',
    path: '/LocalDanmakuHistory',
    name: 'LocalDanmakuHistory',
    component: () => import('../views/LocalDanmakuHistory.vue'),
  },
]

export const router = createRouter({
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      redirect: appMenus[0].path,
    },
    ...appMenus,
  ],
})

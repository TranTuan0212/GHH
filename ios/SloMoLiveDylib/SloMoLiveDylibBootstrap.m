#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

static void SloMoLiveScheduleBootstrap(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        Class entryClass = NSClassFromString(@"SloMoLiveDylibEntry");
        SEL sel = NSSelectorFromString(@"bootstrapFromObjC");
        if (entryClass && [entryClass respondsToSelector:sel]) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
            [entryClass performSelector:sel];
#pragma clang diagnostic pop
        }
    });
}

__attribute__((constructor))
static void SloMoLiveDylibInit(void) {
    NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
    [nc addObserverForName:UIApplicationDidFinishLaunchingNotification
                    object:nil
                     queue:[NSOperationQueue mainQueue]
                usingBlock:^(__unused NSNotification *note) {
        SloMoLiveScheduleBootstrap();
    }];
    [nc addObserverForName:UIApplicationDidBecomeActiveNotification
                    object:nil
                     queue:[NSOperationQueue mainQueue]
                usingBlock:^(__unused NSNotification *note) {
        SloMoLiveScheduleBootstrap();
    }];
}
